import { describe, expect, it } from 'vitest'

import {
  FallbackClassificationSchema,
  FallbackStateSchema,
  classifyFallbackFailure,
  classifyProviderErrorForFallback,
  createFallbackState,
  transitionFallbackState,
} from '../src/index.js'
import { CHROMIUM_CANDIDATE, KITESURF_CANDIDATE, SECOND_KITESURF_CANDIDATE } from './fixtures.js'

const FALLBACK_POLICY = { allowed: true, maximumCrossRuntimeFallbacks: 1 } as const

function createAllocatingState() {
  const requested = createFallbackState(FALLBACK_POLICY)
  const routed = transitionFallbackState(requested, {
    type: 'ROUTE_SELECTED',
    candidate: KITESURF_CANDIDATE,
  })
  return transitionFallbackState(routed, { type: 'ALLOCATION_STARTED' })
}

describe('fallback classification', () => {
  it.each([
    'provider_transient',
    'allocation_timeout',
    'provider_rate_limited',
    'provider_capacity_exhausted',
    'connection_failure',
    'runtime_incompatibility',
  ] as const)('classifies %s as allocation fallback eligible', (failureClass) => {
    expect(classifyFallbackFailure(failureClass)).toEqual({
      failureClass,
      eligible: true,
      reasonCodes: ['FALLBACK_ELIGIBLE'],
    })
  })

  it.each([
    'provider_configuration',
    'provider_authentication',
    'operation_canceled',
    'invalid_client_request',
    'policy_denial',
    'security_denial',
    'tenant_quota_exhausted',
    'no_compatible_candidate',
    'malformed_request',
    'invalid_provider_response',
    'termination_failure',
    'unknown',
  ] as const)('classifies %s as not fallback eligible', (failureClass) => {
    expect(classifyFallbackFailure(failureClass)).toEqual({
      failureClass,
      eligible: false,
      reasonCodes: ['FALLBACK_NOT_ELIGIBLE'],
    })
  })

  it.each([
    ['PROVIDER_OPERATION_TIMEOUT', 'allocation_timeout', true],
    ['PROVIDER_RATE_LIMITED', 'provider_rate_limited', true],
    ['PROVIDER_CAPACITY_EXHAUSTED', 'provider_capacity_exhausted', true],
    ['PROVIDER_TRANSIENT_UPSTREAM_FAILURE', 'provider_transient', true],
    ['PROVIDER_CONNECTION_FAILED', 'connection_failure', true],
    ['PROVIDER_UNSUPPORTED', 'runtime_incompatibility', true],
    ['PROVIDER_AUTHORIZATION_ERROR', 'provider_authentication', false],
    ['PROVIDER_CONFIGURATION_ERROR', 'provider_configuration', false],
    ['PROVIDER_OPERATION_ABORTED', 'operation_canceled', false],
    ['PROVIDER_INVALID_RESPONSE', 'invalid_provider_response', false],
    ['PROVIDER_TERMINATION_FAILED', 'termination_failure', false],
    ['PROVIDER_UNKNOWN_ERROR', 'unknown', false],
  ] as const)('maps %s to %s', (code, failureClass, eligible) => {
    expect(classifyProviderErrorForFallback(code, 'allocate')).toMatchObject({
      failureClass,
      eligible,
    })
  })

  it('does not treat timeouts outside allocation as allocation fallback eligible', () => {
    expect(classifyProviderErrorForFallback('PROVIDER_OPERATION_TIMEOUT', 'health')).toEqual({
      failureClass: 'unknown',
      eligible: false,
      reasonCodes: ['FALLBACK_NOT_ELIGIBLE'],
    })
  })

  it('rejects a contradictory serialized fallback classification', () => {
    expect(
      FallbackClassificationSchema.safeParse({
        failureClass: 'security_denial',
        eligible: true,
        reasonCodes: ['FALLBACK_ELIGIBLE'],
      }).success,
    ).toBe(false)
  })
})

describe('bounded fallback state model', () => {
  it('case 20: moves a transient Kitesurf allocation failure to one Chromium fallback', () => {
    const fallbackRouted = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_FAILED',
      failureClass: 'provider_transient',
      fallbackCandidate: CHROMIUM_CANDIDATE,
    })
    const fallbackAllocating = transitionFallbackState(fallbackRouted, {
      type: 'ALLOCATION_STARTED',
    })
    const active = transitionFallbackState(fallbackAllocating, {
      type: 'ALLOCATION_SUCCEEDED',
    })

    expect(fallbackRouted).toMatchObject({
      status: 'FALLBACK_ROUTED',
      originalCandidate: KITESURF_CANDIDATE,
      currentCandidate: CHROMIUM_CANDIDATE,
      fallbacksUsed: 1,
      primaryFailureClass: 'provider_transient',
      reasonCodes: ['FALLBACK_ELIGIBLE', 'FALLBACK_FROM_RUNTIME'],
    })
    expect(active).toMatchObject({
      status: 'ACTIVE',
      activeCandidate: CHROMIUM_CANDIDATE,
      fallbacksUsed: 1,
      primaryFailureClass: 'provider_transient',
    })
    expect(FallbackStateSchema.parse(active)).toEqual(active)
  })

  it('case 21: never falls back on provider authentication failure', () => {
    const failed = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_FAILED',
      failureClass: 'provider_authentication',
      fallbackCandidate: CHROMIUM_CANDIDATE,
    })

    expect(failed).toMatchObject({
      status: 'FAILED',
      fallbacksUsed: 0,
      reasonCodes: ['FALLBACK_NOT_ELIGIBLE'],
    })
  })

  it.each(['policy_denial', 'security_denial'] as const)(
    'case 22: never falls back around %s',
    (failureClass) => {
      const failed = transitionFallbackState(createAllocatingState(), {
        type: 'ALLOCATION_FAILED',
        failureClass,
        fallbackCandidate: CHROMIUM_CANDIDATE,
      })

      expect(failed).toMatchObject({ status: 'FAILED', fallbacksUsed: 0 })
      if (failed.status !== 'FAILED') {
        throw new Error('Expected policy or security denial to fail')
      }
      expect(failed.reasonCodes).toContain('FALLBACK_NOT_ELIGIBLE')
    },
  )

  it('case 23: stops after the one permitted cross-runtime fallback', () => {
    const fallbackRouted = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_FAILED',
      failureClass: 'provider_transient',
      fallbackCandidate: CHROMIUM_CANDIDATE,
    })
    const fallbackAllocating = transitionFallbackState(fallbackRouted, {
      type: 'ALLOCATION_STARTED',
    })
    const failed = transitionFallbackState(fallbackAllocating, {
      type: 'ALLOCATION_FAILED',
      failureClass: 'connection_failure',
      fallbackCandidate: SECOND_KITESURF_CANDIDATE,
    })

    expect(failed).toMatchObject({
      status: 'FAILED',
      fallbacksUsed: 1,
      primaryFailureClass: 'provider_transient',
      failureClass: 'connection_failure',
    })
    if (failed.status !== 'FAILED') {
      throw new Error('Expected exhausted fallback to fail')
    }
    expect(failed.reasonCodes).toEqual(
      expect.arrayContaining(['FALLBACK_LIMIT_REACHED', 'FALLBACK_NOT_ELIGIBLE']),
    )
    expect(() =>
      transitionFallbackState(failed, {
        type: 'ALLOCATION_FAILED',
        failureClass: 'provider_transient',
        fallbackCandidate: KITESURF_CANDIDATE,
      }),
    ).toThrow()
  })

  it('case 24: permits rate-limited Kitesurf to fall back to compatible Chromium', () => {
    const result = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_FAILED',
      failureClass: 'provider_rate_limited',
      fallbackCandidate: CHROMIUM_CANDIDATE,
    })

    expect(result).toMatchObject({ status: 'FALLBACK_ROUTED', fallbacksUsed: 1 })
  })

  it('does not fall back when policy disables it or no distinct candidate exists', () => {
    const disabledRequested = createFallbackState({
      allowed: false,
      maximumCrossRuntimeFallbacks: 0,
    })
    const disabledRouted = transitionFallbackState(disabledRequested, {
      type: 'ROUTE_SELECTED',
      candidate: KITESURF_CANDIDATE,
    })
    const disabledAllocating = transitionFallbackState(disabledRouted, {
      type: 'ALLOCATION_STARTED',
    })

    expect(
      transitionFallbackState(disabledAllocating, {
        type: 'ALLOCATION_FAILED',
        failureClass: 'provider_transient',
        fallbackCandidate: CHROMIUM_CANDIDATE,
      }),
    ).toMatchObject({
      status: 'FAILED',
      fallbacksUsed: 0,
      reasonCodes: ['FALLBACK_NOT_ELIGIBLE', 'FALLBACK_DISABLED'],
    })
    expect(
      transitionFallbackState(createAllocatingState(), {
        type: 'ALLOCATION_FAILED',
        failureClass: 'provider_transient',
        fallbackCandidate: KITESURF_CANDIDATE,
      }),
    ).toMatchObject({
      status: 'FAILED',
      fallbacksUsed: 0,
      reasonCodes: ['FALLBACK_NOT_ELIGIBLE', 'FALLBACK_SAME_RUNTIME'],
    })
  })

  it('models route failure and primary allocation success without fallback', () => {
    const routeFailed = transitionFallbackState(createFallbackState(FALLBACK_POLICY), {
      type: 'ROUTE_FAILED',
    })
    const active = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_SUCCEEDED',
    })

    expect(routeFailed).toMatchObject({
      status: 'FAILED',
      failureClass: 'no_compatible_candidate',
      fallbacksUsed: 0,
    })
    expect(active).toMatchObject({
      status: 'ACTIVE',
      activeCandidate: KITESURF_CANDIDATE,
      fallbacksUsed: 0,
    })
  })

  it('rejects a serialized state with duplicate attempts or an inconsistent fallback count', () => {
    const active = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_SUCCEEDED',
    })

    expect(
      FallbackStateSchema.safeParse({
        ...active,
        attemptedCandidates: [KITESURF_CANDIDATE, KITESURF_CANDIDATE],
        fallbacksUsed: 1,
      }).success,
    ).toBe(false)
  })

  it('requires a distinct runtime and retains the primary failure across fallback', () => {
    const sameRuntime = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_FAILED',
      failureClass: 'provider_transient',
      fallbackCandidate: SECOND_KITESURF_CANDIDATE,
    })
    const fallbackRouted = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_FAILED',
      failureClass: 'allocation_timeout',
      fallbackCandidate: CHROMIUM_CANDIDATE,
    })

    expect(sameRuntime).toMatchObject({ status: 'FAILED', fallbacksUsed: 0 })
    expect(fallbackRouted).toMatchObject({
      status: 'FALLBACK_ROUTED',
      primaryFailureClass: 'allocation_timeout',
      attemptedCandidates: [KITESURF_CANDIDATE, CHROMIUM_CANDIDATE],
    })
  })

  it('rejects persisted fallback history that exceeds its policy', () => {
    const fallbackRouted = transitionFallbackState(createAllocatingState(), {
      type: 'ALLOCATION_FAILED',
      failureClass: 'provider_transient',
      fallbackCandidate: CHROMIUM_CANDIDATE,
    })

    expect(
      FallbackStateSchema.safeParse({
        ...fallbackRouted,
        fallbackPolicy: { allowed: false, maximumCrossRuntimeFallbacks: 0 },
      }).success,
    ).toBe(false)
  })
})
