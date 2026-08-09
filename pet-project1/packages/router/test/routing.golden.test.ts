import { describe, expect, it } from 'vitest'

import { RoutingDecisionSchema, routeBrowserRuntime } from '../src/index.js'
import {
  CHROMIUM_CANDIDATE_ID,
  KITESURF_CANDIDATE_ID,
  createChromiumSource,
  createDegradedHealth,
  createKitesurfSource,
  createRoutingInput,
  createUnavailableHealth,
} from './fixtures.js'

function selectedRuntime(input: ReturnType<typeof createRoutingInput>): string | null {
  return routeBrowserRuntime(input).selectedCandidate?.runtimeClass ?? null
}

describe('router-v1 golden routing suite', () => {
  it('case 1: selects Kitesurf for a simple compatible HTML/JS workload', () => {
    const decision = routeBrowserRuntime(createRoutingInput())

    expect(RoutingDecisionSchema.parse(decision)).toEqual(decision)
    expect(decision.selectedCandidate?.runtimeClass).toBe('kitesurf')
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining(['CAPABILITIES_SATISFIED', 'FAST_PATH_PREFERRED']),
    )
  })

  it('case 2: rejects Kitesurf and selects Chromium when WebGL is required', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({ requirements: { webgl: 'required' } }),
    )

    expect(decision.selectedCandidate?.runtimeClass).toBe('chromium')
    const rejectedKitesurf = decision.rejectedCandidates.find(
      (candidate) => candidate.candidate.runtimeClass === 'kitesurf',
    )
    expect(rejectedKitesurf?.reasonCodes).toContain('REQUIRES_WEBGL')
  })

  it('case 3: selects experimental Chromium video only with explicit opt-in', () => {
    const allowed = createRoutingInput({
      requirements: { video: 'required' },
      runtime: { preference: 'auto', allowFallback: true, allowExperimental: true },
    })

    expect(selectedRuntime(allowed)).toBe('chromium')
  })

  it('case 4: rejects a runtime without required persistent authentication', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({ requirements: { persistentAuth: 'required' } }),
    )

    expect(decision.selectedCandidate?.runtimeClass).toBe('chromium')
    expect(decision.rejectedCandidates[0]?.reasonCodes).toContain('REQUIRES_PERSISTENT_AUTH')
  })

  it('case 5: selects Chromium when Kitesurf is unavailable', () => {
    const input = createRoutingInput({
      candidateSources: [
        createKitesurfSource({ health: createUnavailableHealth() }),
        createChromiumSource(),
      ],
    })

    expect(selectedRuntime(input)).toBe('chromium')
  })

  it('case 6: applies the documented degraded penalty and retains the narrow fast-path lead', () => {
    const input = createRoutingInput({
      candidateSources: [
        createKitesurfSource({ health: createDegradedHealth() }),
        createChromiumSource(),
      ],
    })
    const decision = routeBrowserRuntime(input)
    const kitesurf = decision.eligibleCandidates.find(
      (item) => item.candidate.candidateID === KITESURF_CANDIDATE_ID,
    )

    expect(kitesurf?.scoreBreakdown.totalScore).toBe(61.25)
    expect(selectedRuntime(input)).toBe('kitesurf')
  })

  it('case 7: selects compatible Kitesurf when Chromium is unavailable', () => {
    const input = createRoutingInput({
      candidateSources: [
        createKitesurfSource(),
        createChromiumSource({ health: createUnavailableHealth() }),
      ],
    })

    expect(selectedRuntime(input)).toBe('kitesurf')
  })

  it('case 8: returns no compatible runtime when both providers are unavailable', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({
        candidateSources: [
          createKitesurfSource({ health: createUnavailableHealth() }),
          createChromiumSource({ health: createUnavailableHealth() }),
        ],
      }),
    )

    expect(decision.outcome).toBe('no_compatible_runtime')
    expect(decision.selectedCandidate).toBeNull()
    expect(decision.reasonCodes).toEqual(['NO_COMPATIBLE_RUNTIME'])
  })

  it('case 9: returns no runtime when WebGL is required and Chromium is forbidden', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({
        requirements: { webgl: 'required' },
        tenantPolicy: { deniedRuntimeClasses: ['chromium'] },
      }),
    )

    expect(decision.selectedCandidate).toBeNull()
    expect(decision.rejectedCandidates).toHaveLength(2)
  })

  it('case 10: hard capability rejection overrides an explicit Kitesurf preference', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({
        requirements: { webgl: 'required' },
        runtime: { preference: 'kitesurf', allowFallback: true, allowExperimental: true },
      }),
    )

    expect(decision.selectedCandidate?.runtimeClass).toBe('chromium')
    expect(decision.rejectedCandidates[0]?.candidate.runtimeClass).toBe('kitesurf')
  })

  it('case 11: fails rather than changing runtime when fallback is disabled', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({
        requirements: { webgl: 'required' },
        runtime: { preference: 'kitesurf', allowFallback: false, allowExperimental: true },
      }),
    )

    expect(decision.selectedCandidate).toBeNull()
    const rejectedChromium = decision.rejectedCandidates.find(
      (candidate) => candidate.candidate.runtimeClass === 'chromium',
    )
    expect(rejectedChromium?.reasonCodes).toContain('RUNTIME_PREFERENCE_REQUIRED')
  })

  it('case 12: rejects experimental support when experimental use is disabled', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({
        runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
      }),
    )

    const rejectedKitesurf = decision.rejectedCandidates.find(
      (candidate) => candidate.candidate.runtimeClass === 'kitesurf',
    )
    expect(rejectedKitesurf?.reasonCodes).toContain('CAPABILITY_EXPERIMENTAL_NOT_ALLOWED')
  })

  it('case 13: allows experimental support with explicit permission', () => {
    const decision = routeBrowserRuntime(createRoutingInput())

    expect(
      decision.eligibleCandidates.some((item) => item.candidate.runtimeClass === 'kitesurf'),
    ).toBe(true)
  })

  it('case 14: rejects unknown required capability support', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({ requirements: { downloads: 'required' } }),
    )

    expect(decision.selectedCandidate).toBeNull()
    expect(
      decision.rejectedCandidates.every((item) => item.reasonCodes.includes('CAPABILITY_UNKNOWN')),
    ).toBe(true)
  })

  it('case 15: keeps candidates eligible when a preferred capability is unavailable', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({ requirements: { webgl: 'preferred' } }),
    )

    expect(decision.eligibleCandidates).toHaveLength(2)
    expect(decision.rejectedCandidates).toHaveLength(0)
  })

  it('case 16: enforces tenant provider deny policy', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({ tenantPolicy: { deniedProviderIDs: ['cloudflare-browser-run'] } }),
    )

    expect(decision.selectedCandidate).toBeNull()
    expect(
      decision.rejectedCandidates.every((item) =>
        item.reasonCodes.includes('CANDIDATE_FORBIDDEN_BY_POLICY'),
      ),
    ).toBe(true)
  })

  it('case 17: enforces a tenant runtime allowlist', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({ tenantPolicy: { allowedRuntimeClasses: ['chromium'] } }),
    )

    expect(decision.selectedCandidate?.runtimeClass).toBe('chromium')
  })

  it('case 18: resolves an exact tie by stable candidate ID every time', () => {
    const input = createRoutingInput({
      signals: {
        efficiency: [{ candidateID: KITESURF_CANDIDATE_ID, score: 60 }],
      },
    })
    const selections = Array.from(
      { length: 20 },
      () => routeBrowserRuntime(input).selectedCandidate?.candidateID,
    )

    expect(new Set(selections)).toEqual(new Set([CHROMIUM_CANDIDATE_ID]))
    expect(
      routeBrowserRuntime(input).eligibleCandidates.flatMap((candidate) => candidate.reasonCodes),
    ).toContain('STABLE_TIE_BREAK')
  })

  it('case 19: replays identical input to an identical decision', () => {
    const input = createRoutingInput()

    expect(routeBrowserRuntime(input)).toEqual(routeBrowserRuntime(input))
  })
})
