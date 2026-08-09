import { RequestIDSchema, RoutingDecisionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { ProviderHealthSchema, ProviderIDSchema, RuntimeClassSchema } from '@surfgate/provider-core'
import { z } from 'zod'

import {
  RoutingCandidateIDSchema,
  createRoutingCandidateIDFromIdentity,
  type RoutingCandidate,
} from './candidate.js'
import { ROUTER_POLICY_VERSION } from './policy-v1.js'
import { RoutingReasonCodeSchema, type RoutingReasonCode } from './reason-code.js'
import {
  CandidateScoreBreakdownSchema,
  compareRankedCandidates,
  hasExactRankTie,
} from './scoring.js'

export const RoutingCandidateIdentitySchema = z
  .object({
    candidateID: RoutingCandidateIDSchema,
    providerID: ProviderIDSchema,
    runtimeClass: RuntimeClassSchema,
    region: z.string().trim().min(1).max(64).optional(),
    configProfile: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((identity, context) => {
    if (
      createRoutingCandidateIDFromIdentity({
        providerID: identity.providerID,
        runtimeClass: identity.runtimeClass,
        ...(identity.region === undefined ? {} : { region: identity.region }),
        ...(identity.configProfile === undefined ? {} : { configProfile: identity.configProfile }),
      }) !== identity.candidateID
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate ID is inconsistent with its canonical identity fields.',
        path: ['candidateID'],
      })
    }
  })
  .readonly()
export type RoutingCandidateIdentity = z.infer<typeof RoutingCandidateIdentitySchema>

const ReasonCodesSchema = z
  .array(RoutingReasonCodeSchema)
  .min(1)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Reason codes must be unique.' })
    }
  })
  .readonly()

export const EligibleRoutingCandidateSchema = z
  .object({
    candidate: RoutingCandidateIdentitySchema,
    scoreBreakdown: CandidateScoreBreakdownSchema,
    reasonCodes: ReasonCodesSchema,
    selected: z.boolean(),
  })
  .strict()
  .readonly()
export type EligibleRoutingCandidate = z.infer<typeof EligibleRoutingCandidateSchema>

export const RejectedRoutingCandidateSchema = z
  .object({
    candidate: RoutingCandidateIdentitySchema,
    reasonCodes: ReasonCodesSchema,
  })
  .strict()
  .readonly()
export type RejectedRoutingCandidate = z.infer<typeof RejectedRoutingCandidateSchema>

export const RoutingHealthSnapshotSchema = z
  .object({
    candidateID: RoutingCandidateIDSchema,
    health: ProviderHealthSchema,
  })
  .strict()
  .readonly()
export type RoutingHealthSnapshot = z.infer<typeof RoutingHealthSnapshotSchema>

export const RoutingFallbackPolicySchema = z
  .object({
    allowed: z.boolean(),
    maximumCrossRuntimeFallbacks: z.union([z.literal(0), z.literal(1)]),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.allowed !== (policy.maximumCrossRuntimeFallbacks === 1)) {
      context.addIssue({
        code: 'custom',
        message: 'Fallback allowance and maximum count are inconsistent.',
      })
    }
  })
  .readonly()
export type RoutingFallbackPolicy = z.infer<typeof RoutingFallbackPolicySchema>

export const RoutingDecisionSchema = z
  .object({
    decisionID: RoutingDecisionIDSchema,
    tenantID: TenantIDSchema,
    requestID: RequestIDSchema,
    policyVersion: z.literal(ROUTER_POLICY_VERSION),
    capabilityRegistryVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
    createdAt: z.iso.datetime({ offset: true }),
    outcome: z.enum(['selected', 'no_compatible_runtime']),
    selectedCandidate: RoutingCandidateIdentitySchema.nullable(),
    eligibleCandidates: z.array(EligibleRoutingCandidateSchema).max(64).readonly(),
    rejectedCandidates: z.array(RejectedRoutingCandidateSchema).max(64).readonly(),
    reasonCodes: ReasonCodesSchema,
    healthSnapshots: z.array(RoutingHealthSnapshotSchema).min(1).max(64).readonly(),
    fallbackPolicy: RoutingFallbackPolicySchema,
  })
  .strict()
  .superRefine((decision, context) => {
    const selectedRecords = decision.eligibleCandidates.filter((candidate) => candidate.selected)
    const eligibleIDs = decision.eligibleCandidates.map(
      (candidate) => candidate.candidate.candidateID,
    )
    const rejectedIDs = decision.rejectedCandidates.map(
      (candidate) => candidate.candidate.candidateID,
    )
    const candidateIDs = [...eligibleIDs, ...rejectedIDs]
    const healthIDs = decision.healthSnapshots.map((snapshot) => snapshot.candidateID)
    const expectedRanking = decision.eligibleCandidates.toSorted(compareRankedCandidates)

    if (new Set(candidateIDs).size !== candidateIDs.length) {
      context.addIssue({
        code: 'custom',
        message: 'A candidate must appear exactly once in a routing decision.',
        path: ['eligibleCandidates'],
      })
    }
    if (
      new Set(healthIDs).size !== healthIDs.length ||
      healthIDs.length !== candidateIDs.length ||
      healthIDs.some((candidateID) => !candidateIDs.includes(candidateID))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Health snapshots must match the decision candidates exactly.',
        path: ['healthSnapshots'],
      })
    }
    if (
      decision.eligibleCandidates.some(
        (candidate, index) =>
          candidate.candidate.candidateID !== expectedRanking[index]?.candidate.candidateID,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Eligible candidates must use the deterministic router-v1 ranking.',
        path: ['eligibleCandidates'],
      })
    }
    const winner = decision.eligibleCandidates[0]
    const runnerUp = decision.eligibleCandidates[1]
    const topRankIsTied =
      winner !== undefined && runnerUp !== undefined && hasExactRankTie(winner, runnerUp)
    const rankReasons: ReadonlySet<RoutingReasonCode> = new Set([
      'SELECTED_HIGHEST_SCORE',
      'LOWER_SCORE',
      'STABLE_TIE_BREAK',
    ])
    for (const [index, candidate] of decision.eligibleCandidates.entries()) {
      const expectedRankReason =
        index === 0
          ? topRankIsTied
            ? 'STABLE_TIE_BREAK'
            : 'SELECTED_HIGHEST_SCORE'
          : winner !== undefined && topRankIsTied && hasExactRankTie(winner, candidate)
            ? 'STABLE_TIE_BREAK'
            : 'LOWER_SCORE'
      const actualRankReasons = candidate.reasonCodes.filter((reasonCode) =>
        rankReasons.has(reasonCode),
      )
      if (actualRankReasons.length !== 1 || actualRankReasons[0] !== expectedRankReason) {
        context.addIssue({
          code: 'custom',
          message: 'Candidate explanation is inconsistent with router-v1 ranking.',
          path: ['eligibleCandidates', index, 'reasonCodes'],
        })
      }
    }

    if (decision.outcome === 'selected') {
      if (decision.selectedCandidate === null || selectedRecords.length !== 1) {
        context.addIssue({ code: 'custom', message: 'A selected decision needs one winner.' })
      } else if (
        selectedRecords[0]?.candidate.candidateID !== decision.selectedCandidate.candidateID
      ) {
        context.addIssue({ code: 'custom', message: 'The selected candidate is inconsistent.' })
      } else if (selectedRecords[0] !== decision.eligibleCandidates[0]) {
        context.addIssue({
          code: 'custom',
          message: 'Only the highest-ranked candidate may be selected.',
          path: ['eligibleCandidates'],
        })
      } else if (
        selectedRecords[0].reasonCodes.length !== decision.reasonCodes.length ||
        selectedRecords[0].reasonCodes.some(
          (reasonCode, index) => reasonCode !== decision.reasonCodes[index],
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Decision reason codes must match the selected candidate explanation.',
          path: ['reasonCodes'],
        })
      }
    } else if (
      decision.selectedCandidate !== null ||
      selectedRecords.length !== 0 ||
      decision.eligibleCandidates.length !== 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A no-compatible decision cannot contain an eligible or selected candidate.',
      })
    } else if (
      decision.reasonCodes.length !== 1 ||
      decision.reasonCodes[0] !== 'NO_COMPATIBLE_RUNTIME'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A no-compatible decision needs the stable no-compatible reason.',
        path: ['reasonCodes'],
      })
    }
  })
  .readonly()
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>

export function toRoutingCandidateIdentity(candidate: RoutingCandidate): RoutingCandidateIdentity {
  return RoutingCandidateIdentitySchema.parse({
    candidateID: candidate.candidateID,
    providerID: candidate.providerID,
    runtimeClass: candidate.runtimeClass,
    ...(candidate.region === undefined ? {} : { region: candidate.region }),
    ...(candidate.configProfile === undefined ? {} : { configProfile: candidate.configProfile }),
  })
}
