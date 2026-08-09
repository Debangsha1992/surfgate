import { describe, expect, it } from 'vitest'

import { relayRedisReconnectDelay } from '../src/redis-coordinator.js'

describe('relay Redis reconnect policy', () => {
  it('uses bounded backoff and stops after the configured attempt limit', () => {
    expect([0, 1, 2, 3, 4].map(relayRedisReconnectDelay)).toEqual([100, 200, 400, 800, 1_000])
    expect(relayRedisReconnectDelay(5)).toBeInstanceOf(Error)
  })
})
