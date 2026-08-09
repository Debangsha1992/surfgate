import { describe, expect, it } from 'vitest'

import {
  ROUTING_REASON_CODES,
  RoutingInputSchema,
  RoutingReasonCodeSchema,
  TenantRoutingPolicySchema,
  buildRoutingCandidates,
  createRoutingCandidateID,
  createRoutingCandidateIDFromIdentity,
} from '../src/index.js'
import {
  CHROMIUM_CANDIDATE_ID,
  KITESURF_CANDIDATE_ID,
  createChromiumSource,
  createKitesurfSource,
} from './fixtures.js'

describe('routing candidate builder', () => {
  it('creates stable provider-neutral IDs and sorts independently of input order', () => {
    const chromium = createChromiumSource()
    const kitesurf = createKitesurfSource()

    expect(createRoutingCandidateID(kitesurf.descriptor)).toBe(KITESURF_CANDIDATE_ID)
    expect(createRoutingCandidateID(chromium.descriptor)).toBe(CHROMIUM_CANDIDATE_ID)
    expect(
      buildRoutingCandidates([kitesurf, chromium]).map((candidate) => candidate.candidateID),
    ).toEqual([CHROMIUM_CANDIDATE_ID, KITESURF_CANDIDATE_ID].sort())
    expect(buildRoutingCandidates([chromium, kitesurf])).toEqual(
      buildRoutingCandidates([kitesurf, chromium]),
    )
  })

  it('keeps missing location values distinct from encoded present values', () => {
    const missing = createKitesurfSource({ descriptor: { configProfile: undefined } })
    const present = createKitesurfSource({ descriptor: { configProfile: '-' } })

    expect(createRoutingCandidateID(missing.descriptor)).not.toBe(
      createRoutingCandidateID(present.descriptor),
    )
  })

  it('supports the full valid Unicode location bound in a deterministic candidate ID', () => {
    const location = '\u0800'.repeat(64)
    const source = createKitesurfSource({
      descriptor: { region: location, configProfile: location },
    })

    expect(createRoutingCandidateID(source.descriptor)).toContain('%E0%A0%80')
  })

  it('encodes malformed UTF-16 deterministically and validates identity helper input', () => {
    const source = createKitesurfSource({ descriptor: { region: '\ud800' } })

    expect(createRoutingCandidateID(source.descriptor)).toContain('%uD800')
    expect(
      createRoutingCandidateIDFromIdentity({
        providerID: source.descriptor.providerID,
        runtimeClass: source.descriptor.runtimeClass,
        region: '\ud800',
        configProfile: source.descriptor.configProfile,
      }),
    ).toBe(createRoutingCandidateID(source.descriptor))
    expect(() =>
      createRoutingCandidateIDFromIdentity({
        providerID: 'INVALID',
        runtimeClass: 'kitesurf',
      }),
    ).toThrow()
  })

  it('rejects duplicate candidate identities', () => {
    const source = createKitesurfSource()

    expect(
      RoutingInputSchema.safeParse({
        decisionID: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        tenantID: 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        requestID: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        createdAt: '2026-08-08T12:00:00.000Z',
        capabilityRegistryVersion: 'cap-v1',
        requirements: {},
        runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
        maxSessionDurationMs: 60_000,
        tenantPolicy: {},
        candidateSources: [source, source],
        signals: {},
      }).success,
    ).toBe(false)
  })
})

describe('routing input and policy boundary', () => {
  it('applies deterministic policy and signal defaults', () => {
    expect(TenantRoutingPolicySchema.parse({})).toEqual({
      deniedProviderIDs: [],
      deniedRuntimeClasses: [],
      preferredRuntime: 'auto',
      allowDegradedProviders: true,
      allowFallback: true,
      allowExperimental: true,
    })
  })

  it('defaults the optional policy and signal containers when omitted', () => {
    const result = RoutingInputSchema.parse({
      decisionID: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      tenantID: 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestID: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      createdAt: '2026-08-08T12:00:00.000Z',
      capabilityRegistryVersion: 'cap-v1',
      requirements: {},
      runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
      maxSessionDurationMs: 60_000,
      candidateSources: [createKitesurfSource()],
    })

    expect(result.tenantPolicy).toEqual(TenantRoutingPolicySchema.parse({}))
    expect(result.signals).toEqual({ compatibility: [], efficiency: [], latency: [] })
  })

  it('rejects unknown signal candidates and duplicate signals', () => {
    const base = {
      decisionID: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      tenantID: 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestID: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      createdAt: '2026-08-08T12:00:00.000Z',
      capabilityRegistryVersion: 'cap-v1',
      requirements: {},
      runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
      maxSessionDurationMs: 60_000,
      tenantPolicy: {},
      candidateSources: [createKitesurfSource()],
    }

    expect(
      RoutingInputSchema.safeParse({
        ...base,
        signals: {
          compatibility: [{ candidateID: CHROMIUM_CANDIDATE_ID, score: 50 }],
        },
      }).success,
    ).toBe(false)
    expect(
      RoutingInputSchema.safeParse({
        ...base,
        signals: {
          latency: [
            { candidateID: KITESURF_CANDIDATE_ID, score: 50 },
            { candidateID: KITESURF_CANDIDATE_ID, score: 70 },
          ],
        },
      }).success,
    ).toBe(false)
  })

  it('rejects arbitrary or secret-shaped fields', () => {
    expect(
      TenantRoutingPolicySchema.safeParse({
        authorization: 'Bearer provider-secret',
      }).success,
    ).toBe(false)
  })
})

describe('stable routing reason codes', () => {
  it('defines the complete machine-readable registry', () => {
    expect(ROUTING_REASON_CODES).toEqual([
      'CAPABILITIES_SATISFIED',
      'FAST_PATH_PREFERRED',
      'REQUESTED_RUNTIME_PREFERENCE',
      'TENANT_RUNTIME_PREFERENCE',
      'CANDIDATE_UNHEALTHY',
      'CANDIDATE_DEGRADED',
      'CANDIDATE_NOT_CONFIGURED',
      'CANDIDATE_FORBIDDEN_BY_POLICY',
      'RUNTIME_FORBIDDEN_BY_POLICY',
      'RUNTIME_PREFERENCE_REQUIRED',
      'SESSION_DURATION_UNSUPPORTED',
      'CANDIDATE_BLOCKED_BY_SAFETY',
      'REQUIRED_CAPABILITY_UNSUPPORTED',
      'REQUIRES_WEBGL',
      'REQUIRES_VIDEO',
      'REQUIRES_PERSISTENT_AUTH',
      'REQUIRES_REAL_BROWSER_TLS',
      'CAPABILITY_UNKNOWN',
      'CAPABILITY_EXPERIMENTAL_NOT_ALLOWED',
      'PREFERRED_CAPABILITY_MATCH',
      'DOMAIN_COMPATIBILITY_LOW',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_CAPACITY_EXHAUSTED',
      'SELECTED_HIGHEST_SCORE',
      'LOWER_SCORE',
      'STABLE_TIE_BREAK',
      'NO_COMPATIBLE_RUNTIME',
      'FALLBACK_ELIGIBLE',
      'FALLBACK_NOT_ELIGIBLE',
      'FALLBACK_DISABLED',
      'FALLBACK_CANDIDATE_UNAVAILABLE',
      'FALLBACK_SAME_RUNTIME',
      'FALLBACK_FROM_RUNTIME',
      'FALLBACK_LIMIT_REACHED',
    ])
    expect(RoutingReasonCodeSchema.safeParse('arbitrary prose').success).toBe(false)
  })
})
