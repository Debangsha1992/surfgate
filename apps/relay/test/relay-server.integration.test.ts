import { createSecretKey } from 'node:crypto'
import { createServer, type ClientRequest, type IncomingMessage, type Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

import type { RelayConfig } from '@surfgate/config'
import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import type { RelayTelemetry } from '@surfgate/observability'
import { createRelayTokenService } from '@surfgate/security'

import {
  createRelayServer,
  type RelayCoordinator,
  type RelayRevocationMessage,
  type RelayServer,
  type RelaySessionRecord,
} from '../src/index.js'

const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const signing = { key: createSecretKey(Buffer.alloc(32, 9)), keyID: 'relay-v1' } as const
const tokens = createRelayTokenService(signing)
const running: RelayServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()))
})

function coordinator() {
  let revocationListener: ((message: RelayRevocationMessage) => void) | undefined
  let controllerOwner: string | undefined
  const value: RelayCoordinator = {
    isSessionRevoked: () => Promise.resolve(false),
    acquireController: ({ ownerID }) => {
      if (controllerOwner !== undefined) return Promise.resolve(false)
      controllerOwner = ownerID
      return Promise.resolve(true)
    },
    renewController: ({ ownerID }) => Promise.resolve(controllerOwner === ownerID),
    releaseController: vi.fn(({ ownerID }) => {
      if (controllerOwner === ownerID) controllerOwner = undefined
      return Promise.resolve()
    }),
    subscribeToRevocations: (listener) => {
      revocationListener = listener
      return Promise.resolve(() => Promise.resolve())
    },
    health: () => Promise.resolve('ready'),
    close: () => Promise.resolve(),
  }
  return {
    value,
    revoke(): void {
      revocationListener?.({ tenantID: TENANT_ID, sessionID: SESSION_ID })
    },
  }
}

function session(expiresAt = new Date(Date.now() + 60_000).toISOString()): RelaySessionRecord {
  return {
    tenantID: TENANT_ID,
    sessionID: SESSION_ID,
    status: 'active',
    expiresAt,
    providerSessionReferenceEncrypted: 'encrypted-provider-session',
  }
}

async function upstreamEchoServer(): Promise<{
  url: string
  close(): Promise<void>
  closed: ReturnType<typeof vi.fn>
}> {
  const http = createServer()
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false })
  const closed = vi.fn()
  wss.on('connection', (socket) => {
    socket.on('message', (data, binary) => socket.send(data, { binary }))
    socket.on('close', closed)
  })
  http.listen(0, '127.0.0.1')
  await waitListening(http)
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('missing address')
  return {
    url: `ws://127.0.0.1:${address.port}`,
    closed,
    async close(): Promise<void> {
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

async function startRelay(
  upstreamURL: string,
  overrides: Readonly<Partial<RelayConfig>> = {},
  sessionExpiresAt?: string,
) {
  const coordination = coordinator()
  const telemetry = {
    recordConnection: vi.fn<RelayTelemetry['recordConnection']>(),
    recordTraffic: vi.fn<RelayTelemetry['recordTraffic']>(),
    setActiveConnections: vi.fn<RelayTelemetry['setActiveConnections']>(),
  } satisfies RelayTelemetry
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const relay = createRelayServer(
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: new URL('ws://127.0.0.1:8081'),
      tokenTTLSeconds: 60,
      connectTimeoutMs: 500,
      idleTimeoutMs: 5_000,
      absoluteTimeoutMs: 30_000,
      maxMessageBytes: 1_024,
      maxQueuedBytes: 2_048,
      leaseTTLms: 1_000,
      authorizationCheckIntervalMs: 250,
      drainTimeoutMs: 1_000,
      ...overrides,
    },
    {
      tokens,
      sessions: {
        findSessionForTenant: () => Promise.resolve(session(sessionExpiresAt)),
      },
      coordinator: coordination.value,
      upstream: {
        resolve: () => ({
          endpoint: upstreamURL,
          headers: { Authorization: 'Bearer provider-secret-token' },
        }),
      },
      telemetry,
      logger,
    },
  )
  running.push(relay)
  const port = await relay.start()
  return { relay, coordination, port, telemetry, logger }
}

function credential(): string {
  return tokens.issue({ tenantID: TENANT_ID, sessionID: SESSION_ID, ttlSeconds: 60 }).token
}

function connect(port: number, token = credential()): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/cdp`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe('relay server integration', () => {
  it('proxies ordered text and binary frames bidirectionally without provider credentials', async () => {
    const upstream = await upstreamEchoServer()
    try {
      const { port, telemetry, logger } = await startRelay(upstream.url)
      const relayToken = credential()
      const client = connect(port, relayToken)
      await waitOpen(client)
      const firstMessage = waitMessage(client)
      client.send('one')
      const first = await firstMessage
      const secondMessage = waitMessage(client)
      client.send(Buffer.from([1, 2, 3]))
      const second = await secondMessage
      expect({ value: first.data.toString(), binary: first.binary }).toEqual({
        value: 'one',
        binary: false,
      })
      expect({ value: second.data.toString(), binary: second.binary }).toEqual({
        value: Buffer.from([1, 2, 3]).toString(),
        binary: true,
      })
      expect(client.url).not.toContain('api.cloudflare.com')
      const logs = JSON.stringify([
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ])
      expect(logs).not.toContain(relayToken)
      expect(logs).not.toContain('provider-secret-token')
      expect(logs).not.toContain(upstream.url)
      expect(
        telemetry.recordConnection.mock.calls.some(
          ([observation]) =>
            observation.event === 'upstream_connect' && observation.outcome === 'success',
        ),
      ).toBe(true)
      client.terminate()
    } finally {
      await upstream.close()
    }
  })

  it('rejects missing credentials and upstream connect failures before upgrade', async () => {
    const { port } = await startRelay('ws://127.0.0.1:1')
    const missing = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/cdp`)
    await expect(waitUnexpectedStatus(missing)).resolves.toBe(401)

    const failed = connect(port)
    await expect(waitUnexpectedStatus(failed)).resolves.toBe(502)
  })

  it('closes both transports on distributed revocation', async () => {
    const upstream = await upstreamEchoServer()
    try {
      const { coordination, port } = await startRelay(upstream.url)
      const client = connect(port)
      await waitOpen(client)
      coordination.revoke()
      const closed = await waitClose(client)
      expect(closed.code).toBe(4403)
      expect(closed.reason.toString()).toBe('SESSION_REVOKED')
      await vi.waitFor(() => expect(upstream.closed).toHaveBeenCalled())
    } finally {
      await upstream.close()
    }
  })

  it('enforces the maximum message size and performs graceful shutdown', async () => {
    const upstream = await upstreamEchoServer()
    try {
      const { relay, port } = await startRelay(upstream.url, {
        maxMessageBytes: 4,
        maxQueuedBytes: 8,
      })
      const client = connect(port)
      await waitOpen(client)
      client.send('12345')
      const closed = await waitClose(client)
      expect(closed.reason.toString()).toBe('MESSAGE_TOO_LARGE')
      await expect(relay.close()).resolves.toBeUndefined()
    } finally {
      await upstream.close()
    }
  })

  it('enforces one distributed controller per session', async () => {
    const upstream = await upstreamEchoServer()
    try {
      const { port } = await startRelay(upstream.url)
      const first = connect(port)
      await waitOpen(first)
      const second = connect(port)
      await expect(waitUnexpectedStatus(second)).resolves.toBe(409)
      first.terminate()
    } finally {
      await upstream.close()
    }
  })

  it('closes inactive and absolute-duration connections with stable reasons', async () => {
    const upstream = await upstreamEchoServer()
    try {
      const idleRelay = await startRelay(upstream.url, {
        idleTimeoutMs: 25,
        absoluteTimeoutMs: 5_000,
      })
      const idleClient = connect(idleRelay.port)
      await waitOpen(idleClient)
      await expect(waitClose(idleClient)).resolves.toMatchObject({
        code: 4408,
        reason: Buffer.from('IDLE_TIMEOUT'),
      })

      const absoluteRelay = await startRelay(upstream.url, {
        idleTimeoutMs: 5_000,
        absoluteTimeoutMs: 25,
        authorizationCheckIntervalMs: 10,
      })
      const absoluteClient = connect(absoluteRelay.port)
      await waitOpen(absoluteClient)
      await expect(waitClose(absoluteClient)).resolves.toMatchObject({
        code: 4408,
        reason: Buffer.from('ABSOLUTE_TIMEOUT'),
      })
    } finally {
      await upstream.close()
    }
  })

  it('closes an active relay when its SurfGate session expires', async () => {
    const upstream = await upstreamEchoServer()
    try {
      const { port } = await startRelay(
        upstream.url,
        {
          idleTimeoutMs: 5_000,
          absoluteTimeoutMs: 5_000,
          authorizationCheckIntervalMs: 10,
        },
        new Date(Date.now() + 250).toISOString(),
      )
      const client = connect(port)
      await waitOpen(client)
      const closed = await waitClose(client)
      expect(closed.code).toBe(4403)
      expect(closed.reason.toString()).toBe('SESSION_EXPIRED')
    } finally {
      await upstream.close()
    }
  })
})

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  throw new Error('Unsupported WebSocket message data.')
}

function waitListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}

function waitOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function waitMessage(socket: WebSocket): Promise<Readonly<{ data: Buffer; binary: boolean }>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data, binary) => resolve({ data: rawDataBuffer(data), binary }))
    socket.once('error', reject)
  })
}

function waitClose(socket: WebSocket): Promise<Readonly<{ code: number; reason: Buffer }>> {
  return new Promise((resolve, reject) => {
    socket.once('close', (code, reason) => resolve({ code, reason }))
    socket.once('error', reject)
  })
}

function waitUnexpectedStatus(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request: ClientRequest, response: IncomingMessage) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.once('error', reject)
  })
}
