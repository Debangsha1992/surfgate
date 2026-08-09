import { CAPABILITY_NAMES, type CapabilitySupportState } from '@surfgate/contracts'
import { z } from 'zod'

import { RoutingCandidateSchema, type RoutingCandidate } from './candidate.js'
import type { CandidateEligibility } from './eligibility.js'
import { ROUTER_V1_POLICY } from './policy-v1.js'
import { RoutingReasonCodeSchema, type RoutingReasonCode } from './reason-code.js'
import type { RoutingInput } from './routing-input.js'

const ScoreSchema = z.number().finite().min(0).max(100)

export const CandidateScoreBreakdownSchema = z
  .object({
    preferenceScore: ScoreSchema,
    efficiencyScore: ScoreSchema,
    compatibilityScore: ScoreSchema,
    healthScore: ScoreSchema,
    latencyScore: ScoreSchema,
    capacityScore: ScoreSchema,
    totalScore: ScoreSchema,
  })
  .strict()
  .superRefine((score, context) => {
    const expectedTotal = roundScore(
      (score.preferenceScore * ROUTER_V1_POLICY.weights.preference +
        score.efficiencyScore * ROUTER_V1_POLICY.weights.efficiency +
        score.compatibilityScore * ROUTER_V1_POLICY.weights.compatibility +
        score.healthScore * ROUTER_V1_POLICY.weights.health +
        score.latencyScore * ROUTER_V1_POLICY.weights.latency +
        score.capacityScore * ROUTER_V1_POLICY.weights.capacity) /
        100,
    )
    if (score.totalScore !== expectedTotal) {
      context.addIssue({
        code: 'custom',
        message: 'Total score is inconsistent with the versioned score components.',
        path: ['totalScore'],
      })
    }
  })
  .readonly()
export type CandidateScoreBreakdown = z.infer<typeof CandidateScoreBreakdownSchema>

type RankableCandidate = Readonly<{
  candidate: Readonly<{ candidateID: RoutingCandidate['candidateID'] }>
  scoreBreakdown: CandidateScoreBreakdown
}>

export function compareRankedCandidates(left: RankableCandidate, right: RankableCandidate): number {
  const scoreDifference = right.scoreBreakdown.totalScore - left.scoreBreakdown.totalScore
  if (scoreDifference !== 0) {
    return scoreDifference
  }
  const preferenceDifference =
    right.scoreBreakdown.preferenceScore - left.scoreBreakdown.preferenceScore
  if (preferenceDifference !== 0) {
    return preferenceDifference
  }
  const efficiencyDifference =
    right.scoreBreakdown.efficiencyScore - left.scoreBreakdown.efficiencyScore
  if (efficiencyDifference !== 0) {
    return efficiencyDifference
  }
  return left.candidate.candidateID < right.candidate.candidateID
    ? -1
    : left.candidate.candidateID > right.candidate.candidateID
      ? 1
      : 0
}

export function hasExactRankTie(left: RankableCandidate, right: RankableCandidate): boolean {
  return (
    left.scoreBreakdown.totalScore === right.scoreBreakdown.totalScore &&
    left.scoreBreakdown.preferenceScore === right.scoreBreakdown.preferenceScore &&
    left.scoreBreakdown.efficiencyScore === right.scoreBreakdown.efficiencyScore
  )
}

export const ScoredRoutingCandidateSchema = z
  .object({
    candidate: RoutingCandidateSchema,
    scoreBreakdown: CandidateScoreBreakdownSchema,
    reasonCodes: z.array(RoutingReasonCodeSchema).min(1).readonly(),
  })
  .strict()
  .readonly()
export type ScoredRoutingCandidate = z.infer<typeof ScoredRoutingCandidateSchema>

function signalScore(
  signals: readonly Readonly<{ candidateID: RoutingCandidate['candidateID']; score: number }>[],
  candidate: RoutingCandidate,
): number | undefined {
  return signals.find((signal) => signal.candidateID === candidate.candidateID)?.score
}

function preferredSupportScore(
  support: CapabilitySupportState,
  allowExperimental: boolean,
): number {
  switch (support) {
    case 'supported':
      return ROUTER_V1_POLICY.preferredCapabilityScores.supported
    case 'experimental':
      return allowExperimental
        ? ROUTER_V1_POLICY.preferredCapabilityScores.experimentalAllowed
        : ROUTER_V1_POLICY.preferredCapabilityScores.experimentalNotAllowed
    case 'unknown':
      return ROUTER_V1_POLICY.preferredCapabilityScores.unknown
    case 'unsupported':
      return ROUTER_V1_POLICY.preferredCapabilityScores.unsupported
  }
}

function roundScore(score: number): number {
  return Math.round(score * 1_000) / 1_000
}

function addReason(reasons: RoutingReasonCode[], reason: RoutingReasonCode): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason)
  }
}

function preferenceScore(
  candidate: RoutingCandidate,
  input: RoutingInput,
  reasons: RoutingReasonCode[],
): number {
  if (input.runtime.preference !== 'auto') {
    if (candidate.runtimeClass === input.runtime.preference) {
      addReason(reasons, 'REQUESTED_RUNTIME_PREFERENCE')
      return ROUTER_V1_POLICY.explicitPreferenceMatchScore
    }
    return ROUTER_V1_POLICY.explicitPreferenceMismatchScore
  }

  if (input.tenantPolicy.preferredRuntime !== 'auto') {
    if (candidate.runtimeClass === input.tenantPolicy.preferredRuntime) {
      addReason(reasons, 'TENANT_RUNTIME_PREFERENCE')
      return ROUTER_V1_POLICY.tenantPreferenceMatchScore
    }
    return ROUTER_V1_POLICY.tenantPreferenceMismatchScore
  }

  return ROUTER_V1_POLICY.neutralPreferenceScore
}

export function scoreEligibleCandidate(
  candidate: RoutingCandidate,
  eligibility: Extract<CandidateEligibility, { eligible: true }>,
  input: RoutingInput,
): ScoredRoutingCandidate {
  const reasons = [...eligibility.reasonCodes]
  const calculatedPreferenceScore = preferenceScore(candidate, input, reasons)
  const calculatedEfficiencyScore =
    signalScore(input.signals.efficiency, candidate) ??
    ROUTER_V1_POLICY.runtimeEfficiencyScores[
      candidate.runtimeClass as keyof typeof ROUTER_V1_POLICY.runtimeEfficiencyScores
    ] ??
    ROUTER_V1_POLICY.defaultRuntimeEfficiencyScore

  if (calculatedEfficiencyScore >= ROUTER_V1_POLICY.fastPathEfficiencyThreshold) {
    addReason(reasons, 'FAST_PATH_PREFERRED')
  }

  const compatibilitySignal =
    signalScore(input.signals.compatibility, candidate) ?? ROUTER_V1_POLICY.defaultSignalScore
  if (compatibilitySignal < ROUTER_V1_POLICY.lowCompatibilityThreshold) {
    addReason(reasons, 'DOMAIN_COMPATIBILITY_LOW')
  }

  const preferredCapabilities = CAPABILITY_NAMES.filter(
    (capability) => input.requirements[capability] === 'preferred',
  )
  let calculatedCompatibilityScore = compatibilitySignal
  if (preferredCapabilities.length > 0) {
    const effectiveAllowExperimental =
      input.runtime.allowExperimental && input.tenantPolicy.allowExperimental
    const preferredAverage =
      preferredCapabilities.reduce(
        (total, capability) =>
          total +
          preferredSupportScore(candidate.capabilities[capability], effectiveAllowExperimental),
        0,
      ) / preferredCapabilities.length
    calculatedCompatibilityScore = roundScore((compatibilitySignal + preferredAverage) / 2)
    if (
      preferredCapabilities.some(
        (capability) =>
          candidate.capabilities[capability] === 'supported' ||
          (candidate.capabilities[capability] === 'experimental' && effectiveAllowExperimental),
      )
    ) {
      addReason(reasons, 'PREFERRED_CAPABILITY_MATCH')
    }
  }

  const calculatedHealthScore = ROUTER_V1_POLICY.healthScores[candidate.health.status]
  const calculatedLatencyScore =
    signalScore(input.signals.latency, candidate) ?? ROUTER_V1_POLICY.defaultSignalScore
  const calculatedCapacityScore = ROUTER_V1_POLICY.capacityScores[candidate.health.capacity]

  const totalScore = roundScore(
    (calculatedPreferenceScore * ROUTER_V1_POLICY.weights.preference +
      calculatedEfficiencyScore * ROUTER_V1_POLICY.weights.efficiency +
      calculatedCompatibilityScore * ROUTER_V1_POLICY.weights.compatibility +
      calculatedHealthScore * ROUTER_V1_POLICY.weights.health +
      calculatedLatencyScore * ROUTER_V1_POLICY.weights.latency +
      calculatedCapacityScore * ROUTER_V1_POLICY.weights.capacity) /
      100,
  )

  return ScoredRoutingCandidateSchema.parse({
    candidate,
    scoreBreakdown: {
      preferenceScore: calculatedPreferenceScore,
      efficiencyScore: calculatedEfficiencyScore,
      compatibilityScore: calculatedCompatibilityScore,
      healthScore: calculatedHealthScore,
      latencyScore: calculatedLatencyScore,
      capacityScore: calculatedCapacityScore,
      totalScore,
    },
    reasonCodes: reasons,
  })
}
