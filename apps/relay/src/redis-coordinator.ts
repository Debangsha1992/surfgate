import type { RedisConfig } from '@surfgate/config'
import { SessionIDSchema, TenantIDSchema, type SessionID, type TenantID } from '@surfgate/contracts'
import { createClient } from 'redis'
import { z } from 'zod'

import type { RelayRevocationReader } from './relay-types.js'

const COMMAND_TIMEOUT_MS = 5_000
const REVOCATION_CHANNEL = 'surfgate:relay:revocations:v1'
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`
const RevocationMessageSchema = z
  .object({ tenantID: TenantIDSchema, sessionID: SessionIDSchema })
  .strict()
  .readonly()

export type RelayRevocationMessage = z.infer<typeof RevocationMessageSchema>

export interface RelayCoordinator extends RelayRevocationReader {
  acquireController(
    input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ownerID: string; ttlMs: number }>,
  ): Promise<boolean>
  renewController(
    input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ownerID: string; ttlMs: number }>,
  ): Promise<boolean>
  releaseController(
    input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ownerID: string }>,
  ): Promise<void>
  subscribeToRevocations(
    listener: (message: RelayRevocationMessage) => void,
  ): Promise<() => Promise<void>>
  health(): Promise<'ready' | 'unavailable'>
  close(): Promise<void>
}

async function bounded<Result>(operation: Promise<Result>): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Redis operation timed out.')),
          COMMAND_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function controllerKey(tenantID: TenantID, sessionID: SessionID): string {
  return `surfgate:relay:controller:${tenantID}:${sessionID}`
}

function revokedKey(tenantID: TenantID, sessionID: SessionID): string {
  return `surfgate:relay:revoked:${tenantID}:${sessionID}`
}

export function createRelayCoordinator(config: RedisConfig): RelayCoordinator {
  const client = createClient({
    url: config.url.href,
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  })
  const subscriber = client.duplicate()
  client.on('error', () => undefined)
  subscriber.on('error', () => undefined)
  let clientConnection: Promise<unknown> | undefined
  let subscriberConnection: Promise<unknown> | undefined
  const ensureClient = async (): Promise<void> => {
    if (client.isReady) return
    clientConnection ??= client.connect().finally(() => {
      clientConnection = undefined
    })
    await bounded(clientConnection)
  }
  const ensureSubscriber = async (): Promise<void> => {
    if (subscriber.isReady) return
    subscriberConnection ??= subscriber.connect().finally(() => {
      subscriberConnection = undefined
    })
    await bounded(subscriberConnection)
  }
  return Object.freeze({
    async isSessionRevoked(rawTenantID: TenantID, rawSessionID: SessionID): Promise<boolean> {
      const tenantID = TenantIDSchema.parse(rawTenantID)
      const sessionID = SessionIDSchema.parse(rawSessionID)
      await ensureClient()
      return (await bounded(client.exists(revokedKey(tenantID, sessionID)))) === 1
    },
    async acquireController(
      input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ownerID: string; ttlMs: number }>,
    ): Promise<boolean> {
      const tenantID = TenantIDSchema.parse(input.tenantID)
      const sessionID = SessionIDSchema.parse(input.sessionID)
      await ensureClient()
      return (
        (await bounded(
          client.set(controllerKey(tenantID, sessionID), input.ownerID, {
            NX: true,
            PX: input.ttlMs,
          }),
        )) === 'OK'
      )
    },
    async renewController(
      input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ownerID: string; ttlMs: number }>,
    ): Promise<boolean> {
      const tenantID = TenantIDSchema.parse(input.tenantID)
      const sessionID = SessionIDSchema.parse(input.sessionID)
      await ensureClient()
      return (
        (await bounded(
          client.eval(RENEW_SCRIPT, {
            keys: [controllerKey(tenantID, sessionID)],
            arguments: [input.ownerID, String(input.ttlMs)],
          }),
        )) === 1
      )
    },
    async releaseController(
      input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ownerID: string }>,
    ): Promise<void> {
      const tenantID = TenantIDSchema.parse(input.tenantID)
      const sessionID = SessionIDSchema.parse(input.sessionID)
      await ensureClient()
      await bounded(
        client.eval(RELEASE_SCRIPT, {
          keys: [controllerKey(tenantID, sessionID)],
          arguments: [input.ownerID],
        }),
      )
    },
    async subscribeToRevocations(
      listener: (message: RelayRevocationMessage) => void,
    ): Promise<() => Promise<void>> {
      await ensureSubscriber()
      const onMessage = (rawMessage: string): void => {
        try {
          const message = RevocationMessageSchema.parse(JSON.parse(rawMessage) as unknown)
          listener(message)
        } catch {
          // Malformed messages never authorize or affect sessions.
        }
      }
      await bounded(subscriber.subscribe(REVOCATION_CHANNEL, onMessage))
      return async (): Promise<void> => {
        if (subscriber.isReady) await bounded(subscriber.unsubscribe(REVOCATION_CHANNEL, onMessage))
      }
    },
    async health(): Promise<'ready' | 'unavailable'> {
      try {
        await ensureClient()
        return (await bounded(client.ping())) === 'PONG' ? 'ready' : 'unavailable'
      } catch {
        return 'unavailable'
      }
    },
    async close(): Promise<void> {
      for (const connection of [subscriber, client]) {
        if (!connection.isOpen) continue
        try {
          await bounded(connection.quit())
        } catch {
          connection.destroy()
        }
      }
    },
  })
}
