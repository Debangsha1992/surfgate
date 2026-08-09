import { afterAll, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '@surfgate/config'
import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { createClient } from 'redis'

import { createRelayCoordinator } from '../../src/index.js'

const coordinator = createRelayCoordinator(loadConfig().redis)
const publisher = createClient({ url: loadConfig().redis.url.href })
publisher.on('error', () => undefined)
afterAll(async () => {
  if (publisher.isOpen) await publisher.quit()
  await coordinator.close()
})

describe('Redis relay coordination integration', () => {
  it('enforces one controller, owner-safe renewal/release, and distributed revocation', async () => {
    const tenantID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FD1')
    const sessionID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FD1')
    const ownerID = `owner-${Date.now()}`
    expect(
      await coordinator.acquireController({ tenantID, sessionID, ownerID, ttlMs: 5_000 }),
    ).toBe(true)
    expect(
      await coordinator.acquireController({
        tenantID,
        sessionID,
        ownerID: `${ownerID}-other`,
        ttlMs: 5_000,
      }),
    ).toBe(false)
    expect(await coordinator.renewController({ tenantID, sessionID, ownerID, ttlMs: 5_000 })).toBe(
      true,
    )
    await coordinator.releaseController({ tenantID, sessionID, ownerID })
    expect(
      await coordinator.acquireController({
        tenantID,
        sessionID,
        ownerID: `${ownerID}-next`,
        ttlMs: 5_000,
      }),
    ).toBe(true)
    await coordinator.releaseController({
      tenantID,
      sessionID,
      ownerID: `${ownerID}-next`,
    })

    const listener = vi.fn()
    const unsubscribe = await coordinator.subscribeToRevocations(listener)
    await publisher.connect()
    const notification = new Promise<void>((resolve) => {
      listener.mockImplementation(() => resolve())
    })
    const revokedKey = `surfgate:relay:revoked:${tenantID}:${sessionID}`
    await publisher.set(revokedKey, '1', { EX: 30 })
    await publisher.publish(
      'surfgate:relay:revocations:v1',
      JSON.stringify({ tenantID, sessionID }),
    )
    await notification
    expect(await coordinator.isSessionRevoked(tenantID, sessionID)).toBe(true)
    expect(listener).toHaveBeenCalledWith({ tenantID, sessionID })
    await publisher.del(revokedKey)
    await unsubscribe()
  })
})
