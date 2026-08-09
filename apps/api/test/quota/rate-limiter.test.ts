import { describe, expect, it, vi } from 'vitest'

import { TenantIDSchema } from '@surfgate/contracts'

import {
  RateLimitDependencyError,
  RateLimitExceededError,
  createRequestRateLimiter,
} from '../../src/quota/rate-limiter.js'

const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')

describe('request rate limiter', () => {
  it('uses tenant/window keys and rejects over-limit requests', async () => {
    const increment = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    const limiter = createRequestRateLimiter(
      { increment, health: () => Promise.resolve('ready'), close: () => Promise.resolve() },
      { now: () => 120_001, windowMs: 60_000 },
    )
    await limiter.check(TENANT_ID, 1)
    await expect(limiter.check(TENANT_ID, 1)).rejects.toBeInstanceOf(RateLimitExceededError)
    expect(increment).toHaveBeenCalledWith(`surfgate:rate:${TENANT_ID}:2`, 60_000)
  })

  it('fails closed when Redis is unavailable', async () => {
    const limiter = createRequestRateLimiter({
      increment: () => Promise.reject(new Error('redis://secret.internal')),
      health: () => Promise.resolve('unavailable'),
      close: () => Promise.resolve(),
    })
    await expect(limiter.check(TENANT_ID, 10)).rejects.toBeInstanceOf(RateLimitDependencyError)
  })
})
