import type { RedisConfig } from '@surfgate/config'
import { createClient } from 'redis'

import type { RateLimitStore } from '../quota/rate-limiter.js'
import type { RelayAuthorizationStore } from '../relay/relay-authorization.js'
import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import type { SessionID, TenantID } from '@surfgate/contracts'

const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`
const COMMAND_TIMEOUT_MS = 5_000

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

export type ControlPlaneRedisStore = RateLimitStore & RelayAuthorizationStore

function revocationKey(tenantID: string, sessionID: string): string {
  return `surfgate:relay:revoked:${tenantID}:${sessionID}`
}

export function createRedisRateLimitStore(config: RedisConfig): ControlPlaneRedisStore {
  const client = createClient({
    url: config.url.href,
    socket: { connectTimeout: 5_000, reconnectStrategy: false },
  })
  client.on('error', () => undefined)
  let connection: Promise<unknown> | undefined
  const ensureConnected = async (): Promise<void> => {
    if (client.isReady) return
    connection ??= client.connect().finally(() => {
      connection = undefined
    })
    await connection
  }
  return Object.freeze({
    async increment(key: string, windowMs: number): Promise<number> {
      await ensureConnected()
      const result = await bounded(
        client.eval(INCREMENT_SCRIPT, {
          keys: [key],
          arguments: [String(windowMs)],
        }),
      )
      if (typeof result !== 'number') throw new Error('Redis returned an invalid rate-limit value.')
      return result
    },
    async health(): Promise<'ready' | 'unavailable'> {
      try {
        await ensureConnected()
        return (await bounded(client.ping())) === 'PONG' ? 'ready' : 'unavailable'
      } catch {
        return 'unavailable'
      }
    },
    async isSessionRevoked(rawTenantID: TenantID, rawSessionID: SessionID): Promise<boolean> {
      const tenantID = TenantIDSchema.parse(rawTenantID)
      const sessionID = SessionIDSchema.parse(rawSessionID)
      await ensureConnected()
      return (await bounded(client.exists(revocationKey(tenantID, sessionID)))) === 1
    },
    async revokeSession(
      input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ttlSeconds: number }>,
    ): Promise<void> {
      const tenantID = TenantIDSchema.parse(input.tenantID)
      const sessionID = SessionIDSchema.parse(input.sessionID)
      const ttlSeconds = Math.max(1, Math.min(86_400, Math.floor(input.ttlSeconds)))
      await ensureConnected()
      const key = revocationKey(tenantID, sessionID)
      await bounded(client.set(key, '1', { EX: ttlSeconds }))
      await bounded(
        client.publish('surfgate:relay:revocations:v1', JSON.stringify({ tenantID, sessionID })),
      )
    },
    async close(): Promise<void> {
      if (!client.isOpen) return
      try {
        await bounded(client.quit())
      } catch {
        client.destroy()
      }
    },
  })
}
