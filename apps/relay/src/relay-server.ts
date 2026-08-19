import { randomBytes } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HTTPServer,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'

import type { RelayConfig } from '@surfgate/config'
import { SessionIDSchema } from '@surfgate/contracts'
import {
  NOOP_RELAY_TELEMETRY,
  settleOperation,
  traceIDFromCarrier,
  type RelayTelemetry,
} from '@surfgate/observability'
import type { RelayTokenService } from '@surfgate/security'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

import { authorizeRelaySession, type AuthorizedRelaySession } from './authorization.js'
import { BoundedMessagePump, RelayStreamLimitError } from './message-pump.js'
import type { RelayCoordinator, RelayRevocationMessage } from './redis-coordinator.js'
import {
  RelayAuthorizationError,
  type RelayFailureCode,
  type RelaySessionRepository,
} from './relay-types.js'
import type { UpstreamConnectionResolver } from './upstream-resolver.js'

const RELAY_PATH_PATTERN = /^\/v1\/sessions\/(ses_[0-7][0-9A-HJKMNP-TV-Z]{25})\/cdp$/u

const CLOSE_CODES: Readonly<Record<RelayFailureCode, number>> = Object.freeze({
  AUTH_REQUIRED: 4401,
  AUTH_INVALID: 4401,
  TOKEN_EXPIRED: 4401,
  SESSION_NOT_FOUND: 4404,
  SESSION_NOT_CONNECTABLE: 4403,
  SESSION_EXPIRED: 4403,
  SESSION_REVOKED: 4403,
  CONNECTION_CONFLICT: 4409,
  UPSTREAM_CONNECT_FAILED: 4502,
  CLIENT_CLOSED: 1000,
  UPSTREAM_CLOSED: 4502,
  MESSAGE_TOO_LARGE: 4400,
  BACKPRESSURE_LIMIT: 4429,
  IDLE_TIMEOUT: 4408,
  ABSOLUTE_TIMEOUT: 4408,
  INTERNAL_ERROR: 4500,
})

export type RelayLogger = Readonly<{
  info(fields: Readonly<Record<string, unknown>>, message: string): void
  warn(fields: Readonly<Record<string, unknown>>, message: string): void
  error(fields: Readonly<Record<string, unknown>>, message: string): void
}>

const NOOP_LOGGER: RelayLogger = Object.freeze({
  info(): void {},
  warn(): void {},
  error(): void {},
})

export interface RelayServer {
  start(): Promise<number>
  close(): Promise<void>
}

type ActiveRelay = Readonly<{
  ownerID: string
  tenantID: AuthorizedRelaySession['tenantID']
  sessionID: AuthorizedRelaySession['sessionID']
  close(code: RelayFailureCode): void
  terminate(): void
}>

function messageBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  throw new Error('Unsupported WebSocket message representation.')
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  if (authorization === undefined) return undefined
  return /^Bearer ([^\s]+)$/u.exec(authorization)?.[1]
}

function rejectUpgrade(socket: Duplex, statusCode: number): void {
  const statusText =
    statusCode === 401
      ? 'Unauthorized'
      : statusCode === 404
        ? 'Not Found'
        : statusCode === 403
          ? 'Forbidden'
          : statusCode === 409
            ? 'Conflict'
            : statusCode === 502
              ? 'Bad Gateway'
              : 'Service Unavailable'
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
}

function statusFor(error: RelayAuthorizationError): number {
  switch (error.code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_INVALID':
    case 'TOKEN_EXPIRED':
      return 401
    case 'SESSION_NOT_FOUND':
      return 404
    case 'CONNECTION_CONFLICT':
      return 409
    case 'UPSTREAM_CONNECT_FAILED':
      return 502
    default:
      return 503
  }
}

function connectUpstream(
  endpoint: string,
  headers: Readonly<{ Authorization?: string | undefined }>,
  timeoutMs: number,
  maxPayload: number,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      headers,
      handshakeTimeout: timeoutMs,
      followRedirects: false,
      maxPayload,
      perMessageDeflate: false,
    })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.terminate()
      reject(new RelayAuthorizationError('UPSTREAM_CONNECT_FAILED'))
    }, timeoutMs)
    socket.once('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.terminate()
      reject(new RelayAuthorizationError('UPSTREAM_CONNECT_FAILED'))
    })
  })
}

function safeTelemetry(operation: () => void): void {
  try {
    operation()
  } catch {
    // Telemetry cannot alter relay lifecycle correctness.
  }
}

async function boundedDependencyHealth(
  operation: () => Promise<'ready' | 'unavailable'>,
  timeoutMs: number,
): Promise<Readonly<{ status: 'ready' | 'unavailable'; durationMs: number }>> {
  const startedAt = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const status = await Promise.race([
      operation().catch(() => 'unavailable' as const),
      new Promise<'unavailable'>((resolve) => {
        timer = setTimeout(() => resolve('unavailable'), timeoutMs)
      }),
    ])
    return { status, durationMs: Math.max(0, performance.now() - startedAt) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createRelayServer(
  config: RelayConfig,
  dependencies: Readonly<{
    tokens: RelayTokenService
    sessions: RelaySessionRepository
    coordinator: RelayCoordinator
    upstream: UpstreamConnectionResolver
    telemetry?: RelayTelemetry
    logger?: RelayLogger
    rawCDPAccess?: 'disabled' | 'trusted'
  }>,
): RelayServer {
  const telemetry = dependencies.telemetry ?? NOOP_RELAY_TELEMETRY
  const logger = dependencies.logger ?? NOOP_LOGGER
  const active = new Map<string, ActiveRelay>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxQueuedBytes,
    perMessageDeflate: false,
  })
  let draining = false
  let started = false
  let startPromise: Promise<number> | undefined
  let closePromise: Promise<void> | undefined
  let unsubscribe: (() => Promise<void>) | undefined

  const handleHTTPRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"alive"}')
      return
    }
    if (request.url === '/health/ready') {
      const [redis, postgres] = await Promise.all([
        boundedDependencyHealth(() => dependencies.coordinator.health(), config.connectTimeoutMs),
        'health' in dependencies.sessions
          ? boundedDependencyHealth(
              () =>
                (
                  dependencies.sessions as RelaySessionRepository & {
                    health(): Promise<'ready' | 'unavailable'>
                  }
                ).health(),
              config.connectTimeoutMs,
            )
          : Promise.resolve({ status: 'ready' as const, durationMs: 0 }),
      ])
      safeTelemetry(() => {
        telemetry.recordDependencyHealth?.({
          dependency: 'redis',
          status: redis.status,
          durationMs: redis.durationMs,
        })
        telemetry.recordDependencyHealth?.({
          dependency: 'postgresql',
          status: postgres.status,
          durationMs: postgres.durationMs,
        })
      })
      const ready = !draining && redis.status === 'ready' && postgres.status === 'ready'
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
      response.end(ready ? '{"status":"ready"}' : '{"status":"unavailable"}')
      return
    }
    response.writeHead(404)
    response.end()
  }
  const http: HTTPServer = createServer((request, response) => {
    void handleHTTPRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(503)
      response.end()
    })
  })

  const closeForRevocation = (message: RelayRevocationMessage): void => {
    active.get(`${message.tenantID}:${message.sessionID}`)?.close('SESSION_REVOKED')
  }

  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    if (draining) {
      rejectUpgrade(socket, 503)
      return
    }
    if (dependencies.rawCDPAccess !== 'trusted') {
      rejectUpgrade(socket, 403)
      return
    }
    let pathSessionID: ReturnType<typeof SessionIDSchema.parse>
    try {
      const url = new URL(request.url ?? '/', 'http://relay.invalid')
      const match = url.search.length === 0 ? RELAY_PATH_PATTERN.exec(url.pathname) : null
      pathSessionID = SessionIDSchema.parse(match?.[1])
    } catch {
      rejectUpgrade(socket, 404)
      return
    }
    const token = bearerToken(request)
    if (token === undefined) {
      rejectUpgrade(socket, 401)
      return
    }
    const startedAt = performance.now()
    const rawTraceParent = request.headers.traceparent
    const authenticationSpan = telemetry.startSpan?.(
      'surfgate.relay.authenticate',
      { operation: 'websocket_upgrade' },
      typeof rawTraceParent === 'string' ? { traceparent: rawTraceParent } : undefined,
    )
    let authorized: AuthorizedRelaySession
    try {
      authorized = await authorizeRelaySession(
        { token, pathSessionID },
        {
          tokens: dependencies.tokens,
          sessions: dependencies.sessions,
          revocations: dependencies.coordinator,
        },
      )
    } catch (error: unknown) {
      const normalized =
        error instanceof RelayAuthorizationError
          ? error
          : new RelayAuthorizationError('INTERNAL_ERROR')
      safeTelemetry(() =>
        telemetry.recordConnection({
          event: 'auth_failure',
          outcome: 'failure',
          reasonCode: normalized.code,
        }),
      )
      authenticationSpan?.end('failure', { reasonCode: normalized.code })
      rejectUpgrade(socket, statusFor(normalized))
      return
    }
    authenticationSpan?.end('success')
    const relayTraceContext = authenticationSpan?.context()
    const traceID = traceIDFromCarrier(relayTraceContext)
    const ownerID = randomBytes(16).toString('base64url')
    let acquired = false
    let upstreamConnectStartedAt: number | undefined
    let upstream: WebSocket | undefined
    try {
      acquired = await dependencies.coordinator.acquireController({
        tenantID: authorized.tenantID,
        sessionID: authorized.sessionID,
        ownerID,
        ttlMs: config.leaseTTLms,
      })
      if (!acquired) throw new RelayAuthorizationError('CONNECTION_CONFLICT')
      authorized = await authorizeRelaySession(
        { token, pathSessionID },
        {
          tokens: dependencies.tokens,
          sessions: dependencies.sessions,
          revocations: dependencies.coordinator,
        },
      )
      const resolved = dependencies.upstream.resolve(authorized)
      const upstreamStartedAt = performance.now()
      upstreamConnectStartedAt = upstreamStartedAt
      const upstreamSpan = telemetry.startSpan?.(
        'surfgate.relay.upstream_connect',
        {},
        relayTraceContext,
      )
      try {
        upstream = await connectUpstream(
          resolved.endpoint,
          resolved.headers,
          config.connectTimeoutMs,
          config.maxQueuedBytes,
        )
        upstreamSpan?.end('success')
      } catch (error: unknown) {
        upstreamSpan?.end('failure', { reasonCode: 'UPSTREAM_CONNECT_FAILED' })
        throw error
      }
      safeTelemetry(() =>
        telemetry.recordConnection({
          event: 'upstream_connect',
          outcome: 'success',
          durationMs: Math.max(0, performance.now() - upstreamStartedAt),
        }),
      )
    } catch (error: unknown) {
      const failedUpstreamStartedAt = upstreamConnectStartedAt
      if (failedUpstreamStartedAt !== undefined) {
        safeTelemetry(() =>
          telemetry.recordConnection({
            event: 'upstream_connect',
            outcome: 'failure',
            durationMs: Math.max(0, performance.now() - failedUpstreamStartedAt),
          }),
        )
      }
      if (upstream !== undefined) upstream.terminate()
      if (acquired) {
        await dependencies.coordinator
          .releaseController({
            tenantID: authorized.tenantID,
            sessionID: authorized.sessionID,
            ownerID,
          })
          .catch(() => undefined)
      }
      const normalized =
        error instanceof RelayAuthorizationError
          ? error
          : new RelayAuthorizationError('UPSTREAM_CONNECT_FAILED')
      rejectUpgrade(socket, statusFor(normalized))
      return
    }
    const connectedUpstream = upstream
    if (draining) {
      connectedUpstream.terminate()
      await dependencies.coordinator
        .releaseController({
          tenantID: authorized.tenantID,
          sessionID: authorized.sessionID,
          ownerID,
        })
        .catch(() => undefined)
      rejectUpgrade(socket, 503)
      return
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      const activeKey = `${authorized.tenantID}:${authorized.sessionID}`
      let closing = false
      let closeReason: RelayFailureCode = 'INTERNAL_ERROR'
      let clientClosed = false
      let upstreamClosed = false
      let lastActivity = Date.now()
      let authorizationCheckRunning = false
      let hardCloseTimer: ReturnType<typeof setTimeout> | undefined
      const timers: ReturnType<typeof setInterval>[] = []
      const finalizeIfClosed = (): void => {
        if (!clientClosed || !upstreamClosed) return
        if (hardCloseTimer !== undefined) clearTimeout(hardCloseTimer)
        for (const timer of timers) clearInterval(timer)
        clientToUpstream.close()
        upstreamToClient.close()
        if (active.get(activeKey)?.ownerID === ownerID) active.delete(activeKey)
        safeTelemetry(() => {
          telemetry.setActiveConnections(active.size)
          telemetry.recordConnection({
            event: 'close',
            outcome: 'success',
            reasonCode: closeReason,
          })
        })
        void dependencies.coordinator
          .releaseController({
            tenantID: authorized.tenantID,
            sessionID: authorized.sessionID,
            ownerID,
          })
          .catch(() => undefined)
      }
      const closeBoth = (code: RelayFailureCode): void => {
        if (closing) return
        closing = true
        closeReason = code
        const closeCode = CLOSE_CODES[code]
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close(closeCode, code)
        }
        if (
          connectedUpstream.readyState === WebSocket.OPEN ||
          connectedUpstream.readyState === WebSocket.CONNECTING
        ) {
          connectedUpstream.close(closeCode, code)
        }
        hardCloseTimer = setTimeout(() => {
          if (!clientClosed) client.terminate()
          if (!upstreamClosed) connectedUpstream.terminate()
        }, config.drainTimeoutMs)
      }
      const failStream = (
        direction: 'client_to_upstream' | 'upstream_to_client',
        code: RelayFailureCode,
      ): void => {
        logger.warn(
          {
            event: 'relay.stream.failed',
            direction,
            code,
            clientState: client.readyState,
            upstreamState: connectedUpstream.readyState,
            traceID,
          },
          'Relay stream failed',
        )
        safeTelemetry(() =>
          telemetry.recordConnection({
            event: 'backpressure',
            outcome: 'failure',
            reasonCode: code,
          }),
        )
        closeBoth(code)
      }
      const clientToUpstream = new BoundedMessagePump(client, connectedUpstream, config, (code) =>
        failStream('client_to_upstream', code),
      )
      const upstreamToClient = new BoundedMessagePump(
        connectedUpstream,
        client,
        config,
        (code) => failStream('upstream_to_client', code),
        (bytes) =>
          safeTelemetry(() =>
            telemetry.recordTraffic({
              direction: 'upstream_to_client',
              bytes,
              frames: 1,
            }),
          ),
      )
      client.on('message', (raw, binary) => {
        lastActivity = Date.now()
        try {
          const data = messageBuffer(raw)
          clientToUpstream.enqueue(data, binary)
          safeTelemetry(() =>
            telemetry.recordTraffic({
              direction: 'client_to_upstream',
              bytes: data.byteLength,
              frames: 1,
            }),
          )
        } catch (error: unknown) {
          if (!(error instanceof RelayStreamLimitError)) closeBoth('INTERNAL_ERROR')
        }
      })
      connectedUpstream.on('message', (raw, binary) => {
        lastActivity = Date.now()
        try {
          const data = messageBuffer(raw)
          upstreamToClient.enqueue(data, binary)
        } catch (error: unknown) {
          if (!(error instanceof RelayStreamLimitError)) closeBoth('INTERNAL_ERROR')
        }
      })
      client.on('close', () => {
        clientClosed = true
        closeBoth('CLIENT_CLOSED')
        finalizeIfClosed()
      })
      connectedUpstream.on('close', () => {
        upstreamClosed = true
        closeBoth('UPSTREAM_CLOSED')
        finalizeIfClosed()
      })
      client.on('error', () => closeBoth('INTERNAL_ERROR'))
      connectedUpstream.on('error', () => closeBoth('UPSTREAM_CLOSED'))

      timers.push(
        setInterval(
          () => {
            if (Date.now() - lastActivity >= config.idleTimeoutMs) {
              closeBoth('IDLE_TIMEOUT')
              return
            }
            if (client.readyState === WebSocket.OPEN) client.ping()
            if (connectedUpstream.readyState === WebSocket.OPEN) connectedUpstream.ping()
          },
          Math.max(250, Math.floor(config.idleTimeoutMs / 2)),
        ),
      )
      const absoluteDeadline = Date.now() + config.absoluteTimeoutMs
      const sessionDeadline =
        authorized.expiresAt === null ? Number.NaN : Date.parse(authorized.expiresAt)
      if (!Number.isFinite(sessionDeadline)) {
        closeBoth('SESSION_EXPIRED')
        return
      }
      timers.push(
        setInterval(
          () => {
            if (Date.now() >= sessionDeadline) {
              closeBoth('SESSION_EXPIRED')
            } else if (Date.now() >= absoluteDeadline) {
              closeBoth('ABSOLUTE_TIMEOUT')
            }
          },
          Math.min(1_000, config.authorizationCheckIntervalMs),
        ),
      )
      timers.push(
        setInterval(() => {
          if (authorizationCheckRunning || closing) return
          authorizationCheckRunning = true
          void Promise.all([
            authorizeRelaySession(
              { token, pathSessionID },
              {
                tokens: dependencies.tokens,
                sessions: dependencies.sessions,
                revocations: dependencies.coordinator,
              },
            ),
            dependencies.coordinator.renewController({
              tenantID: authorized.tenantID,
              sessionID: authorized.sessionID,
              ownerID,
              ttlMs: config.leaseTTLms,
            }),
          ])
            .then(([, renewed]) => {
              if (!renewed) closeBoth('SESSION_REVOKED')
            })
            .catch((error: unknown) =>
              closeBoth(error instanceof RelayAuthorizationError ? error.code : 'INTERNAL_ERROR'),
            )
            .finally(() => {
              authorizationCheckRunning = false
            })
        }, config.authorizationCheckIntervalMs),
      )
      active.set(activeKey, {
        ownerID,
        tenantID: authorized.tenantID,
        sessionID: authorized.sessionID,
        close: closeBoth,
        terminate(): void {
          client.terminate()
          connectedUpstream.terminate()
        },
      })
      safeTelemetry(() => {
        telemetry.setActiveConnections(active.size)
        telemetry.recordConnection({
          event: 'connect',
          outcome: 'success',
          durationMs: Math.max(0, performance.now() - startedAt),
        })
      })
      logger.info({ event: 'relay.connected', traceID }, 'Relay connection established')
      wss.emit('connection', client, request)
    })
  }

  http.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch(() => {
      rejectUpgrade(socket, 503)
    })
  })

  return Object.freeze({
    start(): Promise<number> {
      startPromise ??= (async () => {
        if (closePromise !== undefined) throw new Error('The relay server has been closed.')
        unsubscribe = await dependencies.coordinator.subscribeToRevocations(closeForRevocation)
        await new Promise<void>((resolve, reject) => {
          http.once('error', reject)
          http.listen(config.port, config.host, () => {
            http.removeListener('error', reject)
            resolve()
          })
        })
        started = true
        const address = http.address()
        if (address === null || typeof address === 'string')
          throw new Error('Relay address missing.')
        logger.info({ event: 'relay.startup', port: address.port }, 'SurfGate relay started')
        return address.port
      })()
      return startPromise
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        draining = true
        logger.info(
          { event: 'relay.shutdown.initiated', activeConnections: active.size },
          'SurfGate relay is draining',
        )
        const httpClosed = started
          ? new Promise<void>((resolve) => http.close(() => resolve()))
          : Promise.resolve()
        for (const connection of active.values()) connection.close('INTERNAL_ERROR')
        const deadline = Date.now() + config.drainTimeoutMs
        while (active.size > 0 && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
        }
        if (active.size > 0) {
          logger.warn(
            { event: 'relay.shutdown.drain_timeout', activeConnections: active.size },
            'Relay drain deadline reached',
          )
        }
        for (const connection of active.values()) connection.terminate()
        const terminationDeadline = Date.now() + Math.min(1_000, config.drainTimeoutMs)
        while (active.size > 0 && Date.now() < terminationDeadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
        }
        active.clear()
        const httpResult = await settleOperation(httpClosed, config.drainTimeoutMs)
        if (httpResult.kind !== 'completed') http.closeAllConnections()
        const dependencyResults = await Promise.all([
          settleOperation(unsubscribe?.() ?? Promise.resolve(), config.drainTimeoutMs),
          settleOperation(dependencies.coordinator.close(), config.drainTimeoutMs),
        ])
        const dependencyClosureFailed =
          httpResult.kind !== 'completed' ||
          dependencyResults.some((result) => result.kind !== 'completed')
        if (dependencyClosureFailed) {
          logger.warn(
            { event: 'relay.shutdown.dependency_timeout' },
            'Relay transport or dependency shutdown exceeded its deadline',
          )
        }
        wss.close()
        logger.info({ event: 'relay.shutdown' }, 'SurfGate relay stopped')
        if (dependencyClosureFailed) {
          throw new Error('Relay resource shutdown did not complete within its deadline.')
        }
      })()
      return closePromise
    },
  })
}
