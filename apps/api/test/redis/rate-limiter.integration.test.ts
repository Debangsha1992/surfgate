import { afterAll, describe, expect, it } from 'vitest'

import { loadConfig } from '@surfgate/config'
import { TenantIDSchema } from '@surfgate/contracts'

import { createRequestRateLimiter, RateLimitExceededError } from '../../src/quota/rate-limiter.js'
import { createRedisRateLimitStore } from '../../src/redis/redis-client.js'

const store = createRedisRateLimitStore(loadConfig().redis)
afterAll(async () => store.close())

describe('Redis distributed rate limit integration', () => {
  it('atomically rejects the second request in a tenant window', async () => {
    const tenantID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FC1')
    const uniqueWindow = Date.now() * 60_000
    const limiter = createRequestRateLimiter(store, { now: () => uniqueWindow })
    await limiter.check(tenantID, 1)
    await expect(limiter.check(tenantID, 1)).rejects.toBeInstanceOf(RateLimitExceededError)
  })

  it('isolates equal rate-limit windows between tenants', async () => {
    const tenantA = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FC2')
    const tenantB = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FC3')
    const uniqueWindow = Date.now() * 60_000
    const limiter = createRequestRateLimiter(store, { now: () => uniqueWindow })

    await expect(limiter.check(tenantA, 1)).resolves.toBeUndefined()
    await expect(limiter.check(tenantB, 1)).resolves.toBeUndefined()
  })
})
