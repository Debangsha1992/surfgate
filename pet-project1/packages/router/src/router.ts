import { buildRoutingCandidates } from './candidate.js'
import { evaluateCandidateEligibility } from './eligibility.js'
import { ROUTER_POLICY_VERSION, ROUTER_V1_POLICY } from './policy-v1.js'
import type { RoutingReasonCode } from './reason-code.js'
import {
  RoutingDecisionSchema,
  toRoutingCandidateIdentity,
  type EligibleRoutingCandidate,
  type RejectedRoutingCandidate,
  type RoutingDecision,
} from './routing-decision.js'
import { RoutingInputSchema, type RoutingInput } from './routing-input.js'
import {
  compareRankedCandidates,
  hasExactRankTie,
  scoreEligibleCandidate,
  type ScoredRoutingCandidate,
} from './scoring.js'

function appendReason(
  reasons: readonly RoutingReasonCode[],
  reason: RoutingReasonCode,
): readonly RoutingReasonCode[] {
  return reasons.includes(reason) ? reasons : Object.freeze([...reasons, reason])
}

export function routeBrowserRuntime(rawInput: RoutingInput): RoutingDecision {
  const input = RoutingInputSchema.parse(rawInput)
  const candidates = buildRoutingCandidates(input.candidateSources)
  const rejectedCandidates: RejectedRoutingCandidate[] = []
  const scoredCandidates: ScoredRoutingCandidate[] = []

  for (const candidate of candidates) {
    const eligibility = evaluateCandidateEligibility(candidate, input)
    if (!eligibility.eligible) {
      rejectedCandidates.push({
        candidate: toRoutingCandidateIdentity(candidate),
        reasonCodes: eligibility.reasonCodes,
      })
      continue
    }
    scoredCandidates.push(scoreEligibleCandidate(candidate, eligibility, input))
  }

  const rankedCandidates = scoredCandidates.toSorted(compareRankedCandidates)
  const winner = rankedCandidates[0]
  const runnerUp = rankedCandidates[1]
  const exactTopTie =
    winner !== undefined && runnerUp !== undefined && hasExactRankTie(winner, runnerUp)

  const eligibleCandidates: EligibleRoutingCandidate[] = rankedCandidates.map(
    (candidate, index) => {
      const selected = index === 0
      const reasonCode = selected
        ? exactTopTie
          ? 'STABLE_TIE_BREAK'
          : 'SELECTED_HIGHEST_SCORE'
        : exactTopTie && winner !== undefined && hasExactRankTie(winner, candidate)
          ? 'STABLE_TIE_BREAK'
          : 'LOWER_SCORE'
      return {
        candidate: toRoutingCandidateIdentity(candidate.candidate),
        scoreBreakdown: candidate.scoreBreakdown,
        reasonCodes: appendReason(candidate.reasonCodes, reasonCode),
        selected,
      }
    },
  )

  const effectiveFallbackAllowed =
    winner !== undefined && input.runtime.allowFallback && input.tenantPolicy.allowFallback
  const decision = {
    decisionID: input.decisionID,
    tenantID: input.tenantID,
    requestID: input.requestID,
    policyVersion: ROUTER_POLICY_VERSION,
    capabilityRegistryVersion: input.capabilityRegistryVersion,
    createdAt: input.createdAt,
    outcome: winner === undefined ? 'no_compatible_runtime' : 'selected',
    selectedCandidate: winner === undefined ? null : toRoutingCandidateIdentity(winner.candidate),
    eligibleCandidates,
    rejectedCandidates,
    reasonCodes:
      winner === undefined
        ? (['NO_COMPATIBLE_RUNTIME'] as const)
        : (eligibleCandidates[0]?.reasonCodes ?? ['NO_COMPATIBLE_RUNTIME']),
    healthSnapshots: candidates.map((candidate) => ({
      candidateID: candidate.candidateID,
      health: candidate.health,
    })),
    fallbackPolicy: {
      allowed: effectiveFallbackAllowed,
      maximumCrossRuntimeFallbacks: effectiveFallbackAllowed
        ? ROUTER_V1_POLICY.maximumCrossRuntimeFallbacks
        : 0,
    },
  } as const

  return RoutingDecisionSchema.parse(decision)
}
