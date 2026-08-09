import { describe, expect, it } from 'vitest'

import { LivenessResponseSchema, ReadinessResponseSchema } from '../src/index.js'

describe('control-plane health contracts', () => {
  it('validates the liveness response', () => {
    expect(LivenessResponseSchema.parse({ status: 'alive' })).toEqual({ status: 'alive' })
  })

  it.each([
    ['ready', 'ready'],
    ['not_ready', 'unavailable'],
  ] as const)('validates %s readiness without diagnostic leakage', (status, postgres) => {
    expect(ReadinessResponseSchema.parse({ status, dependencies: { postgres } })).toEqual({
      status,
      dependencies: { postgres },
    })
  })

  it('rejects unexpected health fields', () => {
    expect(
      ReadinessResponseSchema.safeParse({
        status: 'not_ready',
        dependencies: { postgres: 'unavailable', connectionString: 'postgres://secret' },
      }).success,
    ).toBe(false)
  })
})
