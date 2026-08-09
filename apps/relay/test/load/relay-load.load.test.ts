import { createSecretKey } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { once } from 'node:events'
import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { createRelayTokenService } from '@surfgate/security'

import {
  createRelayServer,
  type RelayCoordinator,
  type RelaySessionRecord,
} from '../../src/index.js'

const CONNECTIONS = 20
const FRAMES_PER_CONNECTION = 20
const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')

function sessionID(sequence: number) {
  return SessionIDSchema.parse(`ses_0${sequence.toString().padStart(25, '0')}`)
}

describe('developer-safe relay load smoke', () => {
  it('handles bounded connection churn and burst traffic without leaked ownership', async () => {
    const upstreamHTTP = createServer()
    const upstreamWSS = new WebSocketServer({ server: upstreamHTTP, perMessageDeflate: false })
    upstreamWSS.on('connection', (socket) => {
      socket.on('message', (data, binary) => socket.send(data, { binary }))
    })
    upstreamHTTP.listen(0, '127.0.0.1')
    await once(upstreamHTTP, 'listening')
    const upstreamAddress = upstreamHTTP.address()
    if (upstreamAddress === null || typeof upstreamAddress === 'string') {
      throw new Error('Upstream address missing.')
    }

    const owners = new Map<string, string>()
    const coordinator: RelayCoordinator = {
      isSessionRevoked: () => Promise.resolve(false),
      acquireController: ({ sessionID: id, ownerID }) => {
        if (owners.has(id)) return Promise.resolve(false)
        owners.set(id, ownerID)
        return Promise.resolve(true)
      },
      renewController: ({ sessionID: id, ownerID }) => Promise.resolve(owners.get(id) === ownerID),
      releaseController: ({ sessionID: id, ownerID }) => {
        if (owners.get(id) === ownerID) owners.delete(id)
        return Promise.resolve()
      },
      subscribeToRevocations: () => Promise.resolve(() => Promise.resolve()),
      health: () => Promise.resolve('ready'),
      close: () => Promise.resolve(),
    }
    const tokens = createRelayTokenService({
      key: createSecretKey(Buffer.alloc(32, 4)),
      keyID: 'load-v1',
    })
    const sessions = new Map<string, RelaySessionRecord>()
    for (let index = 1; index <= CONNECTIONS; index += 1) {
      const id = sessionID(index)
      sessions.set(id, {
        tenantID: TENANT_ID,
        sessionID: id,
        status: 'active',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        providerSessionReferenceEncrypted: 'load-protected-reference',
      })
    }
    const relay = createRelayServer(
      {
        host: '127.0.0.1',
        port: 0,
        publicURL: new URL('ws://127.0.0.1:8081'),
        tokenTTLSeconds: 60,
        connectTimeoutMs: 1_000,
        idleTimeoutMs: 10_000,
        absoluteTimeoutMs: 30_000,
        maxMessageBytes: 1_024,
        maxQueuedBytes: 8_192,
        leaseTTLms: 2_000,
        authorizationCheckIntervalMs: 500,
        drainTimeoutMs: 2_000,
      },
      {
        tokens,
        sessions: {
          findSessionForTenant: (_tenantID, id) => Promise.resolve(sessions.get(id) ?? null),
        },
        coordinator,
        upstream: {
          resolve: () => ({
            endpoint: `ws://127.0.0.1:${upstreamAddress.port}`,
            headers: {},
          }),
        },
      },
    )
    const eventLoop = monitorEventLoopDelay({ resolution: 10 })
    eventLoop.enable()
    const rssBefore = process.memoryUsage().rss
    const startedAt = performance.now()
    const port = await relay.start()
    let receivedFrames = 0
    let slowConsumers = 0
    let abruptDisconnects = 0
    await Promise.all(
      [...sessions.values()].map(async (session, index) => {
        const token = tokens.issue({
          tenantID: TENANT_ID,
          sessionID: session.sessionID,
          ttlSeconds: 60,
        }).token
        const client = new WebSocket(
          `ws://127.0.0.1:${port}/v1/sessions/${session.sessionID}/cdp`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
        await once(client, 'open')
        const slowConsumer = index % 5 === 0
        if (slowConsumer) {
          slowConsumers += 1
          client.pause()
        }
        const complete = new Promise<void>((resolve) => {
          let received = 0
          client.on('message', () => {
            received += 1
            receivedFrames += 1
            if (received === FRAMES_PER_CONNECTION) resolve()
          })
        })
        for (let frame = 0; frame < FRAMES_PER_CONNECTION; frame += 1) {
          client.send(`frame-${frame}`)
        }
        if (slowConsumer) setImmediate(() => client.resume())
        await complete
        const closed = once(client, 'close')
        if (index % 4 === 0) {
          abruptDisconnects += 1
          client.terminate()
        } else {
          client.close()
        }
        await closed
      }),
    )
    await relay.close()
    eventLoop.disable()
    const durationMs = Math.max(1, performance.now() - startedAt)
    const result = {
      connections: CONNECTIONS,
      frames: receivedFrames,
      messagesPerSecond: Math.round((receivedFrames / durationMs) * 1_000),
      durationMs: Math.round(durationMs),
      rssDeltaBytes: process.memoryUsage().rss - rssBefore,
      eventLoopDelayP95Ms: Number(eventLoop.percentile(95) / 1_000_000),
      slowConsumers,
      abruptDisconnects,
      leakedOwners: owners.size,
    }
    process.stdout.write(`${JSON.stringify({ relayLoadSmoke: result })}\n`)
    expect(receivedFrames).toBe(CONNECTIONS * FRAMES_PER_CONNECTION)
    expect(owners.size).toBe(0)
    expect(upstreamWSS.clients.size).toBe(0)
    await new Promise<void>((resolve) => upstreamWSS.close(() => resolve()))
    await new Promise<void>((resolve) => upstreamHTTP.close(() => resolve()))
  })
})
