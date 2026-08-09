import { describe, expect, it } from 'vitest'

import { buildRoutingCandidates, evaluateCandidateEligibility } from '../src/index.js'
import {
  CHROMIUM_CANDIDATE_ID,
  KITESURF_CANDIDATE_ID,
  ROUTING_NOW,
  createChromiumSource,
  createDegradedHealth,
  createKitesurfSource,
  createRoutingInput,
  createUnavailableHealth,
} from './fixtures.js'

function candidate(runtime: 'kitesurf' | 'chromium', input = createRoutingInput()) {
  const candidates = buildRoutingCandidates(input.candidateSources)
  const expectedID = runtime === 'kitesurf' ? KITESURF_CANDIDATE_ID : CHROMIUM_CANDIDATE_ID
  const result = candidates.find((item) => item.candidateID === expectedID)
  if (result === undefined) {
    throw new Error(`Missing ${runtime} test candidate`)
  }
  return result
}

describe('hard candidate eligibility', () => {
  it('accepts supported and explicitly permitted experimental requirements', () => {
    const input = createRoutingInput({
      requirements: { javascript: 'required' },
      runtime: { preference: 'auto', allowFallback: true, allowExperimental: true },
    })

    expect(evaluateCandidateEligibility(candidate('kitesurf', input), input)).toMatchObject({
      eligible: true,
      reasonCodes: ['CAPABILITIES_SATISFIED'],
    })
    expect(evaluateCandidateEligibility(candidate('chromium', input), input)).toMatchObject({
      eligible: true,
      reasonCodes: ['CAPABILITIES_SATISFIED'],
    })
  })

  it.each([
    ['unsupported', { webgl: 'required' }, ['REQUIRES_WEBGL', 'REQUIRED_CAPABILITY_UNSUPPORTED']],
    ['unknown', { downloads: 'required' }, ['CAPABILITY_UNKNOWN']],
    [
      'experimental without opt-in',
      { javascript: 'required' },
      ['CAPABILITY_EXPERIMENTAL_NOT_ALLOWED'],
    ],
  ] as const)('rejects a %s required capability', (_name, requirements, expectedReasons) => {
    const input = createRoutingInput({
      requirements,
      runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
    })
    const result = evaluateCandidateEligibility(candidate('kitesurf', input), input)

    expect(result.eligible).toBe(false)
    expect(result.reasonCodes).toEqual(expect.arrayContaining([...expectedReasons]))
  })

  it('never rejects a preferred or not-required capability', () => {
    const input = createRoutingInput({
      requirements: { webgl: 'preferred', video: 'not_required' },
    })

    expect(evaluateCandidateEligibility(candidate('kitesurf', input), input).eligible).toBe(true)
  })

  it('rejects a provider or runtime forbidden by tenant policy', () => {
    const providerDenied = createRoutingInput({
      tenantPolicy: { deniedProviderIDs: ['cloudflare-browser-run'] },
    })
    const runtimeDenied = createRoutingInput({
      tenantPolicy: { allowedRuntimeClasses: ['chromium'] },
    })

    expect(
      evaluateCandidateEligibility(candidate('kitesurf', providerDenied), providerDenied),
    ).toMatchObject({ eligible: false, reasonCodes: ['CANDIDATE_FORBIDDEN_BY_POLICY'] })
    expect(
      evaluateCandidateEligibility(candidate('kitesurf', runtimeDenied), runtimeDenied),
    ).toMatchObject({ eligible: false, reasonCodes: ['RUNTIME_FORBIDDEN_BY_POLICY'] })
  })

  it('treats a preferred runtime as strict only when effective fallback is disabled', () => {
    const strict = createRoutingInput({
      runtime: { preference: 'kitesurf', allowFallback: false, allowExperimental: true },
    })
    const flexible = createRoutingInput({
      runtime: { preference: 'kitesurf', allowFallback: true, allowExperimental: true },
    })

    expect(evaluateCandidateEligibility(candidate('chromium', strict), strict)).toMatchObject({
      eligible: false,
      reasonCodes: ['RUNTIME_PREFERENCE_REQUIRED'],
    })
    expect(evaluateCandidateEligibility(candidate('chromium', flexible), flexible).eligible).toBe(
      true,
    )
  })

  it('rejects unconfigured and unavailable candidates', () => {
    const unconfiguredInput = createRoutingInput({
      candidateSources: [
        createKitesurfSource({ health: createUnavailableHealth(false) }),
        createChromiumSource(),
      ],
    })
    const unavailableInput = createRoutingInput({
      candidateSources: [
        createKitesurfSource({ health: createUnavailableHealth() }),
        createChromiumSource(),
      ],
    })

    expect(
      evaluateCandidateEligibility(candidate('kitesurf', unconfiguredInput), unconfiguredInput),
    ).toMatchObject({ eligible: false, reasonCodes: ['CANDIDATE_NOT_CONFIGURED'] })
    expect(
      evaluateCandidateEligibility(candidate('kitesurf', unavailableInput), unavailableInput),
    ).toMatchObject({ eligible: false, reasonCodes: ['CANDIDATE_UNHEALTHY'] })
  })

  it('keeps degraded candidates eligible only when policy permits', () => {
    const allowed = createRoutingInput({
      candidateSources: [
        createKitesurfSource({ health: createDegradedHealth() }),
        createChromiumSource(),
      ],
    })
    const denied = createRoutingInput({
      tenantPolicy: { allowDegradedProviders: false },
      candidateSources: allowed.candidateSources,
    })

    expect(evaluateCandidateEligibility(candidate('kitesurf', allowed), allowed)).toMatchObject({
      eligible: true,
      reasonCodes: ['CAPABILITIES_SATISFIED', 'CANDIDATE_DEGRADED'],
    })
    expect(evaluateCandidateEligibility(candidate('kitesurf', denied), denied)).toMatchObject({
      eligible: false,
      reasonCodes: ['CANDIDATE_DEGRADED'],
    })
  })

  it('rejects exhausted capacity, duration overflow, and product safety blocks', () => {
    const exhaustedHealth = {
      status: 'degraded',
      configured: true,
      diagnosticCode: 'PROVIDER_DEGRADED',
      capacity: 'exhausted',
      checkedAt: ROUTING_NOW,
    } as const
    const exhausted = createRoutingInput({
      candidateSources: [createKitesurfSource({ health: exhaustedHealth }), createChromiumSource()],
    })
    const tooLong = createRoutingInput({ maxSessionDurationMs: 600_001 })
    const blocked = createRoutingInput({
      candidateSources: [
        createKitesurfSource({ safety: { status: 'blocked' } }),
        createChromiumSource(),
      ],
    })

    const exhaustedResult = evaluateCandidateEligibility(
      candidate('kitesurf', exhausted),
      exhausted,
    )
    const tooLongResult = evaluateCandidateEligibility(candidate('kitesurf', tooLong), tooLong)
    const blockedResult = evaluateCandidateEligibility(candidate('kitesurf', blocked), blocked)

    expect(exhaustedResult.eligible).toBe(false)
    expect(exhaustedResult.reasonCodes).toContain('PROVIDER_CAPACITY_EXHAUSTED')
    expect(tooLongResult.eligible).toBe(false)
    expect(tooLongResult.reasonCodes).toContain('SESSION_DURATION_UNSUPPORTED')
    expect(blockedResult.eligible).toBe(false)
    expect(blockedResult.reasonCodes).toContain('CANDIDATE_BLOCKED_BY_SAFETY')
  })
})
