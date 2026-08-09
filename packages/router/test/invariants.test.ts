import { describe, expect, it } from 'vitest'

import { RoutingDecisionSchema, routeBrowserRuntime } from '../src/index.js'
import {
  KITESURF_CANDIDATE_ID,
  createChromiumSource,
  createKitesurfSource,
  createRoutingInput,
  createUnavailableHealth,
} from './fixtures.js'

describe('routing invariants', () => {
  it.each([
    createRoutingInput({ requirements: { webgl: 'required' } }),
    createRoutingInput({ tenantPolicy: { deniedRuntimeClasses: ['kitesurf'] } }),
    createRoutingInput({
      candidateSources: [
        createKitesurfSource({ health: createUnavailableHealth() }),
        createChromiumSource(),
      ],
    }),
  ])('never selects a rejected candidate', (input) => {
    const decision = routeBrowserRuntime(input)
    const rejectedIDs = decision.rejectedCandidates.map((item) => item.candidate.candidateID)

    expect(rejectedIDs).not.toContain(decision.selectedCandidate?.candidateID)
  })

  it('does not let maximum scoring signals override an unsupported hard capability', () => {
    const decision = routeBrowserRuntime(
      createRoutingInput({
        requirements: { webgl: 'required' },
        signals: {
          compatibility: [{ candidateID: KITESURF_CANDIDATE_ID, score: 100 }],
          efficiency: [{ candidateID: KITESURF_CANDIDATE_ID, score: 100 }],
          latency: [{ candidateID: KITESURF_CANDIDATE_ID, score: 100 }],
        },
      }),
    )

    expect(decision.selectedCandidate?.runtimeClass).toBe('chromium')
  })

  it('does not let maximum scoring signals override policy or unavailable health', () => {
    const signals = {
      compatibility: [{ candidateID: KITESURF_CANDIDATE_ID, score: 100 }],
      efficiency: [{ candidateID: KITESURF_CANDIDATE_ID, score: 100 }],
      latency: [{ candidateID: KITESURF_CANDIDATE_ID, score: 100 }],
    }
    const policyDenied = routeBrowserRuntime(
      createRoutingInput({ tenantPolicy: { deniedRuntimeClasses: ['kitesurf'] }, signals }),
    )
    const unavailable = routeBrowserRuntime(
      createRoutingInput({
        candidateSources: [
          createKitesurfSource({ health: createUnavailableHealth() }),
          createChromiumSource(),
        ],
        signals,
      }),
    )

    expect(policyDenied.selectedCandidate?.runtimeClass).toBe('chromium')
    expect(unavailable.selectedCandidate?.runtimeClass).toBe('chromium')
  })

  it('runtime-validates a persistence-safe decision and rejects secret-shaped additions', () => {
    const decision = routeBrowserRuntime(createRoutingInput())

    expect(RoutingDecisionSchema.parse(JSON.parse(JSON.stringify(decision)))).toEqual(decision)
    expect(
      RoutingDecisionSchema.safeParse({
        ...decision,
        authorization: 'Bearer provider-secret',
      }).success,
    ).toBe(false)
    const winner = decision.eligibleCandidates.find((candidate) => candidate.selected)
    if (winner === undefined) {
      throw new Error('Expected a selected candidate fixture')
    }
    const contradictoryWinnerReasons = [
      ...winner.reasonCodes,
      'LOWER_SCORE' as const,
      'STABLE_TIE_BREAK' as const,
    ]
    expect(
      RoutingDecisionSchema.safeParse({
        ...decision,
        eligibleCandidates: decision.eligibleCandidates.map((candidate) =>
          candidate.selected
            ? { ...candidate, reasonCodes: contradictoryWinnerReasons }
            : candidate,
        ),
        reasonCodes: contradictoryWinnerReasons,
      }).success,
    ).toBe(false)
    expect(JSON.stringify(decision)).not.toMatch(/Bearer|authorization|credential|token/iu)
  })

  it('rejects inconsistent persisted candidate and health references', () => {
    const decision = routeBrowserRuntime(createRoutingInput())
    const selected = decision.eligibleCandidates[0]
    if (selected === undefined) {
      throw new Error('Expected a selected candidate fixture')
    }

    expect(
      RoutingDecisionSchema.safeParse({
        ...decision,
        rejectedCandidates: [
          ...decision.rejectedCandidates,
          { candidate: selected.candidate, reasonCodes: ['CANDIDATE_UNHEALTHY'] },
        ],
      }).success,
    ).toBe(false)
    expect(
      RoutingDecisionSchema.safeParse({
        ...decision,
        healthSnapshots: decision.healthSnapshots.slice(1),
      }).success,
    ).toBe(false)
    expect(
      RoutingDecisionSchema.safeParse({
        ...decision,
        reasonCodes: ['CAPABILITIES_SATISFIED'],
      }).success,
    ).toBe(false)
    expect(
      RoutingDecisionSchema.safeParse({
        ...decision,
        selectedCandidate: {
          ...decision.selectedCandidate,
          runtimeClass: 'forged-runtime',
        },
      }).success,
    ).toBe(false)
    expect(
      RoutingDecisionSchema.safeParse({
        ...decision,
        eligibleCandidates: decision.eligibleCandidates.map((candidate) =>
          candidate.selected
            ? {
                ...candidate,
                scoreBreakdown: { ...candidate.scoreBreakdown, totalScore: 99 },
              }
            : candidate,
        ),
      }).success,
    ).toBe(false)
    const lowerRanked = decision.eligibleCandidates[1]
    if (lowerRanked === undefined) {
      throw new Error('Expected two eligible candidates')
    }
    expect(
      RoutingDecisionSchema.safeParse({
        ...decision,
        selectedCandidate: lowerRanked.candidate,
        eligibleCandidates: decision.eligibleCandidates.map((candidate) => ({
          ...candidate,
          selected: candidate.candidate.candidateID === lowerRanked.candidate.candidateID,
        })),
        reasonCodes: lowerRanked.reasonCodes,
      }).success,
    ).toBe(false)
  })
})
