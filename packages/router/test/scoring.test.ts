import { describe, expect, it } from 'vitest'

import {
  ROUTER_POLICY_VERSION,
  ROUTER_V1_POLICY,
  buildRoutingCandidates,
  evaluateCandidateEligibility,
  scoreEligibleCandidate,
} from '../src/index.js'
import {
  CHROMIUM_CANDIDATE_ID,
  KITESURF_CANDIDATE_ID,
  createChromiumSource,
  createDegradedHealth,
  createKitesurfSource,
  createRoutingInput,
} from './fixtures.js'

function eligibleCandidate(runtime: 'kitesurf' | 'chromium', input = createRoutingInput()) {
  const expectedID = runtime === 'kitesurf' ? KITESURF_CANDIDATE_ID : CHROMIUM_CANDIDATE_ID
  const candidate = buildRoutingCandidates(input.candidateSources).find(
    (item) => item.candidateID === expectedID,
  )
  if (candidate === undefined) {
    throw new Error(`Missing ${runtime} candidate`)
  }
  const eligibility = evaluateCandidateEligibility(candidate, input)
  if (!eligibility.eligible) {
    throw new Error(`Expected ${runtime} candidate to be eligible`)
  }
  return { candidate, eligibility }
}

describe('router-v1 policy', () => {
  it('stores every weight and default in one immutable versioned policy', () => {
    expect(ROUTER_POLICY_VERSION).toBe('router-v1')
    expect(ROUTER_V1_POLICY.weights).toEqual({
      preference: 30,
      efficiency: 25,
      compatibility: 20,
      health: 15,
      latency: 5,
      capacity: 5,
    })
    expect(Object.values(ROUTER_V1_POLICY.weights).reduce((sum, value) => sum + value, 0)).toBe(100)
    expect(Object.isFrozen(ROUTER_V1_POLICY)).toBe(true)
  })

  it('gives the compatible Kitesurf fast path a higher deterministic default score', () => {
    const input = createRoutingInput()
    const kitesurf = eligibleCandidate('kitesurf', input)
    const chromium = eligibleCandidate('chromium', input)

    const kitesurfScore = scoreEligibleCandidate(kitesurf.candidate, kitesurf.eligibility, input)
    const chromiumScore = scoreEligibleCandidate(chromium.candidate, chromium.eligibility, input)

    expect(kitesurfScore.scoreBreakdown).toEqual({
      preferenceScore: 50,
      efficiencyScore: 100,
      compatibilityScore: 50,
      healthScore: 100,
      latencyScore: 50,
      capacityScore: 50,
      totalScore: 70,
    })
    expect(chromiumScore.scoreBreakdown.totalScore).toBe(60)
    expect(kitesurfScore.reasonCodes).toContain('FAST_PATH_PREFERRED')
  })

  it('applies explicit runtime preference without bypassing eligibility', () => {
    const input = createRoutingInput({
      runtime: { preference: 'chromium', allowFallback: true, allowExperimental: true },
    })
    const chromium = eligibleCandidate('chromium', input)

    const score = scoreEligibleCandidate(chromium.candidate, chromium.eligibility, input)

    expect(score.scoreBreakdown.preferenceScore).toBe(100)
    expect(score.reasonCodes).toContain('REQUESTED_RUNTIME_PREFERENCE')
  })

  it('applies tenant preference when the request preference is automatic', () => {
    const input = createRoutingInput({ tenantPolicy: { preferredRuntime: 'chromium' } })
    const chromium = eligibleCandidate('chromium', input)

    const score = scoreEligibleCandidate(chromium.candidate, chromium.eligibility, input)

    expect(score.scoreBreakdown.preferenceScore).toBe(100)
    expect(score.reasonCodes).toContain('TENANT_RUNTIME_PREFERENCE')
  })

  it('penalizes degraded health deterministically without making it ineligible', () => {
    const input = createRoutingInput({
      candidateSources: [
        createKitesurfSource({ health: createDegradedHealth() }),
        createChromiumSource(),
      ],
    })
    const kitesurf = eligibleCandidate('kitesurf', input)

    const score = scoreEligibleCandidate(kitesurf.candidate, kitesurf.eligibility, input)

    expect(score.scoreBreakdown.healthScore).toBe(50)
    expect(score.scoreBreakdown.capacityScore).toBe(25)
    expect(score.scoreBreakdown.totalScore).toBe(61.25)
    expect(score.reasonCodes).toContain('CANDIDATE_DEGRADED')
  })

  it('uses optional normalized signals and preferred capabilities without rejecting', () => {
    const input = createRoutingInput({
      requirements: { webgl: 'preferred' },
      signals: {
        compatibility: [{ candidateID: CHROMIUM_CANDIDATE_ID, score: 80 }],
        efficiency: [{ candidateID: CHROMIUM_CANDIDATE_ID, score: 90 }],
        latency: [{ candidateID: CHROMIUM_CANDIDATE_ID, score: 70 }],
      },
    })
    const chromium = eligibleCandidate('chromium', input)

    const score = scoreEligibleCandidate(chromium.candidate, chromium.eligibility, input)

    expect(score.scoreBreakdown).toMatchObject({
      efficiencyScore: 90,
      compatibilityScore: 90,
      latencyScore: 70,
    })
    expect(score.reasonCodes).toContain('PREFERRED_CAPABILITY_MATCH')
  })

  it('records a low compatibility reason from a supplied signal', () => {
    const input = createRoutingInput({
      signals: {
        compatibility: [{ candidateID: KITESURF_CANDIDATE_ID, score: 20 }],
      },
    })
    const kitesurf = eligibleCandidate('kitesurf', input)

    expect(
      scoreEligibleCandidate(kitesurf.candidate, kitesurf.eligibility, input).reasonCodes,
    ).toContain('DOMAIN_COMPATIBILITY_LOW')
  })
})
