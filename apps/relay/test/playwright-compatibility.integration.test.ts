import { createSecretKey } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright-core'
import { WebSocketServer, type RawData } from 'ws'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { createRelayTokenService } from '@surfgate/security'

import {
  createRelayServer,
  type RelayCoordinator,
  type RelayServer,
  type RelaySessionRecord,
} from '../src/index.js'

const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const PROVIDER_AUTHORIZATION = 'Bearer synthetic-provider-credential'
const tokens = createRelayTokenService({
  key: createSecretKey(Buffer.alloc(32, 3)),
  keyID: 'compatibility-v1',
})
const runningRelays: RelayServer[] = []

afterEach(async () => {
  await Promise.all(runningRelays.splice(0).map((relay) => relay.close()))
})

type CDPRequest = Readonly<{
  id: number
  method: string
  sessionId?: string
}>

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  throw new Error('Unsupported WebSocket message data.')
}

function parseCDPRequest(data: RawData): CDPRequest {
  const value = JSON.parse(rawDataBuffer(data).toString('utf8')) as unknown
  if (
    value === null ||
    typeof value !== 'object' ||
    !('id' in value) ||
    typeof value.id !== 'number' ||
    !('method' in value) ||
    typeof value.method !== 'string'
  ) {
    throw new Error('Playwright sent an invalid CDP command.')
  }
  const sessionId =
    'sessionId' in value && typeof value.sessionId === 'string' ? value.sessionId : undefined
  return { id: value.id, method: value.method, ...(sessionId === undefined ? {} : { sessionId }) }
}

function resultFor(method: string): Readonly<Record<string, unknown>> {
  if (method === 'Browser.getVersion') {
    return {
      protocolVersion: '1.3',
      product: 'Chrome/123.0.0.0',
      revision: '@surfgate-local-fixture',
      userAgent: 'SurfGate local Playwright compatibility fixture',
      jsVersion: '12.3',
    }
  }
  if (method === 'Target.getBrowserContexts') return { browserContextIds: [] }
  if (method === 'Target.getTargetInfo') {
    return {
      targetInfo: {
        targetId: 'surfgate-browser',
        type: 'browser',
        title: '',
        url: '',
        attached: true,
        canAccessOpener: false,
      },
    }
  }
  return {}
}

async function createFakeCDPServer(): Promise<
  Readonly<{
    url: string
    authorizationHeaders: string[]
    methods: string[]
    close(): Promise<void>
  }>
> {
  const http = createServer()
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false })
  const authorizationHeaders: string[] = []
  const methods: string[] = []
  wss.on('connection', (socket, request: IncomingMessage) => {
    const authorization = request.headers.authorization
    if (authorization !== undefined) authorizationHeaders.push(authorization)
    socket.on('message', (data) => {
      const command = parseCDPRequest(data)
      methods.push(command.method)
      socket.send(
        JSON.stringify({
          id: command.id,
          result: resultFor(command.method),
          ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
        }),
      )
    })
  })
  http.listen(0, '127.0.0.1')
  await waitListening(http)
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Missing CDP address.')
  return Object.freeze({
    url: `ws://127.0.0.1:${address.port}`,
    authorizationHeaders,
    methods,
    async close(): Promise<void> {
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  })
}

function waitListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}

function coordinator(): RelayCoordinator {
  let owner: string | undefined
  return {
    isSessionRevoked: () => Promise.resolve(false),
    acquireController: ({ ownerID }) => {
      if (owner !== undefined) return Promise.resolve(false)
      owner = ownerID
      return Promise.resolve(true)
    },
    renewController: ({ ownerID }) => Promise.resolve(owner === ownerID),
    releaseController: ({ ownerID }) => {
      if (owner === ownerID) owner = undefined
      return Promise.resolve()
    },
    subscribeToRevocations: () => Promise.resolve(() => Promise.resolve()),
    health: () => Promise.resolve('ready'),
    close: () => Promise.resolve(),
  }
}

describe('Playwright CDP compatibility', () => {
  it('connects through SurfGate headers without exposing provider credentials', async () => {
    const upstream = await createFakeCDPServer()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const session: RelaySessionRecord = {
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      providerSessionReferenceEncrypted: 'synthetic-protected-reference',
    }
    const relay = createRelayServer(
      {
        host: '127.0.0.1',
        port: 0,
        publicURL: new URL('ws://127.0.0.1:8081'),
        tokenTTLSeconds: 60,
        connectTimeoutMs: 1_000,
        idleTimeoutMs: 5_000,
        absoluteTimeoutMs: 30_000,
        maxMessageBytes: 1_024 * 1_024,
        maxQueuedBytes: 2 * 1_024 * 1_024,
        leaseTTLms: 2_000,
        authorizationCheckIntervalMs: 500,
        drainTimeoutMs: 1_000,
      },
      {
        tokens,
        sessions: { findSessionForTenant: () => Promise.resolve(session) },
        coordinator: coordinator(),
        upstream: {
          resolve: () => ({
            endpoint: upstream.url,
            headers: { Authorization: PROVIDER_AUTHORIZATION },
          }),
        },
        logger,
        rawCDPAccess: 'trusted',
      },
    )
    runningRelays.push(relay)
    try {
      const port = await relay.start()
      const relayToken = tokens.issue({
        tenantID: TENANT_ID,
        sessionID: SESSION_ID,
        ttlSeconds: 60,
      }).token
      const browser = await chromium.connectOverCDP(
        `ws://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/cdp`,
        { headers: { Authorization: `Bearer ${relayToken}` } },
      )
      expect(browser.version()).toBe('123.0.0.0')
      expect(upstream.authorizationHeaders).toEqual([PROVIDER_AUTHORIZATION])
      expect(upstream.methods).toContain('Browser.getVersion')
      const clientVisibleData = JSON.stringify({
        relayURL: `ws://127.0.0.1:${port}/v1/sessions/${SESSION_ID}/cdp`,
        relayToken,
      })
      expect(clientVisibleData).not.toContain(PROVIDER_AUTHORIZATION)
      const logs = JSON.stringify([
        ...logger.info.mock.calls,
        ...logger.warn.mock.calls,
        ...logger.error.mock.calls,
      ])
      expect(logs).not.toContain(PROVIDER_AUTHORIZATION)
      expect(logs).not.toContain(upstream.url)
      await browser.close()
    } finally {
      await upstream.close()
    }
  })
})
