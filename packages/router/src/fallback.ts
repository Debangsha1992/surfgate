import {
  ProviderErrorCodeSchema,
  ProviderOperationSchema,
  type ProviderErrorCode,
  type ProviderOperation,
} from '@surfgate/provider-core'
import { z } from 'zod'

import { RoutingReasonCodeSchema } from './reason-code.js'
import { RoutingCandidateIdentitySchema, RoutingFallbackPolicySchema } from './routing-decision.js'

export const FALLBACK_FAILURE_CLASSES = [
  'provider_transient',
  'allocation_timeout',
  'provider_rate_limited',
  'provider_capacity_exhausted',
  'connection_failure',
  'runtime_incompatibility',
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
] as const

export const FallbackFailureClassSchema = z.enum(FALLBACK_FAILURE_CLASSES)
export type FallbackFailureClass = z.infer<typeof FallbackFailureClassSchema>

const FALLBACK_ELIGIBLE_FAILURES = new Set<FallbackFailureClass>([
  'provider_transient',
  'allocation_timeout',
  'provider_rate_limited',
  'provider_capacity_exhausted',
  'connection_failure',
  'runtime_incompatibility',
])

export const FallbackClassificationSchema = z
  .object({
    failureClass: FallbackFailureClassSchema,
    eligible: z.boolean(),
    reasonCodes: z.array(RoutingReasonCodeSchema).min(1).readonly(),
  })
  .strict()
  .superRefine((classification, context) => {
    const expectedEligibility = FALLBACK_ELIGIBLE_FAILURES.has(classification.failureClass)
    const expectedReason = expectedEligibility ? 'FALLBACK_ELIGIBLE' : 'FALLBACK_NOT_ELIGIBLE'
    if (classification.eligible !== expectedEligibility) {
      context.addIssue({
        code: 'custom',
        message: 'Fallback eligibility is inconsistent with the failure class.',
        path: ['eligible'],
      })
    }
    if (
      classification.reasonCodes.length !== 1 ||
      classification.reasonCodes[0] !== expectedReason
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Fallback reason is inconsistent with the failure class.',
        path: ['reasonCodes'],
      })
    }
  })
  .readonly()
export type FallbackClassification = z.infer<typeof FallbackClassificationSchema>

const PROVIDER_ERROR_FAILURE_CLASS = {
  PROVIDER_CONFIGURATION_ERROR: 'provider_configuration',
  PROVIDER_AUTHORIZATION_ERROR: 'provider_authentication',
  PROVIDER_OPERATION_ABORTED: 'operation_canceled',
  PROVIDER_OPERATION_TIMEOUT: 'allocation_timeout',
  PROVIDER_RATE_LIMITED: 'provider_rate_limited',
  PROVIDER_CAPACITY_EXHAUSTED: 'provider_capacity_exhausted',
  PROVIDER_TRANSIENT_UPSTREAM_FAILURE: 'provider_transient',
  PROVIDER_UNSUPPORTED: 'runtime_incompatibility',
  PROVIDER_CONNECTION_FAILED: 'connection_failure',
  PROVIDER_INVALID_RESPONSE: 'invalid_provider_response',
  PROVIDER_TERMINATION_FAILED: 'termination_failure',
  PROVIDER_UNKNOWN_ERROR: 'unknown',
} as const satisfies Readonly<Record<ProviderErrorCode, FallbackFailureClass>>

export function classifyFallbackFailure(
  rawFailureClass: FallbackFailureClass,
): FallbackClassification {
  const failureClass = FallbackFailureClassSchema.parse(rawFailureClass)
  const eligible = FALLBACK_ELIGIBLE_FAILURES.has(failureClass)
  return FallbackClassificationSchema.parse({
    failureClass,
    eligible,
    reasonCodes: [eligible ? 'FALLBACK_ELIGIBLE' : 'FALLBACK_NOT_ELIGIBLE'],
  })
}

export function classifyProviderErrorForFallback(
  rawCode: ProviderErrorCode,
  rawOperation: ProviderOperation,
): FallbackClassification {
  const code = ProviderErrorCodeSchema.parse(rawCode)
  const operation = ProviderOperationSchema.parse(rawOperation)
  if (operation !== 'allocate') {
    return classifyFallbackFailure(
      code === 'PROVIDER_CONFIGURATION_ERROR'
        ? 'provider_configuration'
        : code === 'PROVIDER_AUTHORIZATION_ERROR'
          ? 'provider_authentication'
          : code === 'PROVIDER_OPERATION_ABORTED'
            ? 'operation_canceled'
            : operation === 'terminate'
              ? 'termination_failure'
              : 'unknown',
    )
  }
  return classifyFallbackFailure(PROVIDER_ERROR_FAILURE_CLASS[code])
}

const FallbackCountSchema = z.union([z.literal(0), z.literal(1)])
const AttemptedCandidatesSchema = z.array(RoutingCandidateIdentitySchema).max(2).readonly()
const ActiveAttemptedCandidatesSchema = z
  .array(RoutingCandidateIdentitySchema)
  .min(1)
  .max(2)
  .readonly()
const FallbackReasonCodesSchema = z
  .array(RoutingReasonCodeSchema)
  .min(1)
  .superRefine((reasonCodes, context) => {
    if (new Set(reasonCodes).size !== reasonCodes.length) {
      context.addIssue({ code: 'custom', message: 'Fallback reason codes must be unique.' })
    }
  })
  .readonly()

const RequestedFallbackStateSchema = z
  .object({
    status: z.literal('REQUESTED'),
    fallbackPolicy: RoutingFallbackPolicySchema,
  })
  .strict()
  .readonly()

const RoutedFallbackStateSchema = z
  .object({
    status: z.literal('ROUTED'),
    currentCandidate: RoutingCandidateIdentitySchema,
    attemptedCandidates: z.tuple([RoutingCandidateIdentitySchema]).readonly(),
    fallbacksUsed: z.literal(0),
    fallbackPolicy: RoutingFallbackPolicySchema,
  })
  .strict()
  .readonly()

const AllocatingFallbackStateSchema = z
  .object({
    status: z.literal('ALLOCATING'),
    currentCandidate: RoutingCandidateIdentitySchema,
    attemptedCandidates: z.tuple([RoutingCandidateIdentitySchema]).readonly(),
    fallbacksUsed: z.literal(0),
    fallbackPolicy: RoutingFallbackPolicySchema,
  })
  .strict()
  .readonly()

const FallbackRoutedStateSchema = z
  .object({
    status: z.literal('FALLBACK_ROUTED'),
    originalCandidate: RoutingCandidateIdentitySchema,
    currentCandidate: RoutingCandidateIdentitySchema,
    attemptedCandidates: z
      .tuple([RoutingCandidateIdentitySchema, RoutingCandidateIdentitySchema])
      .readonly(),
    fallbacksUsed: z.literal(1),
    fallbackPolicy: RoutingFallbackPolicySchema,
    primaryFailureClass: FallbackFailureClassSchema,
    reasonCodes: FallbackReasonCodesSchema,
  })
  .strict()
  .readonly()

const FallbackAllocatingStateSchema = z
  .object({
    status: z.literal('FALLBACK_ALLOCATING'),
    originalCandidate: RoutingCandidateIdentitySchema,
    currentCandidate: RoutingCandidateIdentitySchema,
    attemptedCandidates: z
      .tuple([RoutingCandidateIdentitySchema, RoutingCandidateIdentitySchema])
      .readonly(),
    fallbacksUsed: z.literal(1),
    fallbackPolicy: RoutingFallbackPolicySchema,
    primaryFailureClass: FallbackFailureClassSchema,
    reasonCodes: FallbackReasonCodesSchema,
  })
  .strict()
  .readonly()

const ActiveFallbackStateSchema = z
  .object({
    status: z.literal('ACTIVE'),
    activeCandidate: RoutingCandidateIdentitySchema,
    attemptedCandidates: ActiveAttemptedCandidatesSchema,
    fallbacksUsed: FallbackCountSchema,
    fallbackPolicy: RoutingFallbackPolicySchema,
    primaryFailureClass: FallbackFailureClassSchema.optional(),
  })
  .strict()
  .readonly()

const FailedFallbackStateSchema = z
  .object({
    status: z.literal('FAILED'),
    attemptedCandidates: AttemptedCandidatesSchema,
    fallbacksUsed: FallbackCountSchema,
    fallbackPolicy: RoutingFallbackPolicySchema,
    primaryFailureClass: FallbackFailureClassSchema.optional(),
    failureClass: FallbackFailureClassSchema,
    reasonCodes: FallbackReasonCodesSchema,
  })
  .strict()
  .readonly()

export const FallbackStateSchema = z
  .discriminatedUnion('status', [
    RequestedFallbackStateSchema,
    RoutedFallbackStateSchema,
    AllocatingFallbackStateSchema,
    FallbackRoutedStateSchema,
    FallbackAllocatingStateSchema,
    ActiveFallbackStateSchema,
    FailedFallbackStateSchema,
  ])
  .superRefine((state, context) => {
    if (state.status === 'REQUESTED') {
      return
    }

    const attemptedCandidateIDs = state.attemptedCandidates.map(
      (candidate) => candidate.candidateID,
    )
    if (new Set(attemptedCandidateIDs).size !== attemptedCandidateIDs.length) {
      context.addIssue({
        code: 'custom',
        message: 'A candidate may only be attempted once.',
        path: ['attemptedCandidates'],
      })
    }
    if (
      state.fallbacksUsed > state.fallbackPolicy.maximumCrossRuntimeFallbacks ||
      (state.fallbacksUsed === 1 && !state.fallbackPolicy.allowed)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Fallback history exceeds the effective fallback policy.',
        path: ['fallbackPolicy'],
      })
    }
    if (
      state.fallbacksUsed === 1 &&
      (state.attemptedCandidates.length !== 2 ||
        state.attemptedCandidates[0]?.runtimeClass === state.attemptedCandidates[1]?.runtimeClass)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A fallback must cross to a distinct runtime.',
        path: ['attemptedCandidates'],
      })
    }
    if (
      'primaryFailureClass' in state &&
      state.primaryFailureClass !== undefined &&
      !FALLBACK_ELIGIBLE_FAILURES.has(state.primaryFailureClass)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A recorded primary fallback failure must be fallback eligible.',
        path: ['primaryFailureClass'],
      })
    }

    if (state.status === 'ROUTED' || state.status === 'ALLOCATING') {
      if (state.currentCandidate.candidateID !== state.attemptedCandidates[0].candidateID) {
        context.addIssue({
          code: 'custom',
          message: 'The current candidate must match the primary attempt.',
          path: ['currentCandidate'],
        })
      }
      return
    }

    if (state.status === 'FALLBACK_ROUTED' || state.status === 'FALLBACK_ALLOCATING') {
      if (
        state.originalCandidate.candidateID !== state.attemptedCandidates[0].candidateID ||
        state.currentCandidate.candidateID !== state.attemptedCandidates[1].candidateID
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Fallback identities must match the ordered attempts.',
          path: ['attemptedCandidates'],
        })
      }
      return
    }

    const validAttemptCount =
      state.status === 'ACTIVE'
        ? state.attemptedCandidates.length === state.fallbacksUsed + 1
        : state.fallbacksUsed === 1
          ? state.attemptedCandidates.length === 2
          : state.attemptedCandidates.length <= 1
    if (!validAttemptCount) {
      context.addIssue({
        code: 'custom',
        message: 'Attempt history is inconsistent with the fallback count.',
        path: ['attemptedCandidates'],
      })
    }
    if (
      state.status === 'ACTIVE' &&
      state.activeCandidate.candidateID !== state.attemptedCandidates.at(-1)?.candidateID
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The active candidate must be the final attempted candidate.',
        path: ['activeCandidate'],
      })
    }
    if (
      (state.status === 'ACTIVE' || state.status === 'FAILED') &&
      (state.fallbacksUsed === 1) !== (state.primaryFailureClass !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Fallback states must retain the primary allocation failure.',
        path: ['primaryFailureClass'],
      })
    }
  })
  .readonly()
export type FallbackState = z.infer<typeof FallbackStateSchema>

export const FallbackEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ROUTE_SELECTED'),
      candidate: RoutingCandidateIdentitySchema,
    })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal('ROUTE_FAILED') })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal('ALLOCATION_STARTED') })
    .strict()
    .readonly(),
  z
    .object({ type: z.literal('ALLOCATION_SUCCEEDED') })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal('ALLOCATION_FAILED'),
      failureClass: FallbackFailureClassSchema,
      fallbackCandidate: RoutingCandidateIdentitySchema.optional(),
    })
    .strict()
    .readonly(),
])
export type FallbackEvent = z.infer<typeof FallbackEventSchema>

export function createFallbackState(
  fallbackPolicy: z.input<typeof RoutingFallbackPolicySchema>,
): FallbackState {
  return FallbackStateSchema.parse({
    status: 'REQUESTED',
    fallbackPolicy: RoutingFallbackPolicySchema.parse(fallbackPolicy),
  })
}

function failedState(
  state: Extract<FallbackState, { status: 'ALLOCATING' | 'FALLBACK_ALLOCATING' }>,
  failureClass: FallbackFailureClass,
  reasonCodes: readonly z.infer<typeof RoutingReasonCodeSchema>[],
): FallbackState {
  return FallbackStateSchema.parse({
    status: 'FAILED',
    attemptedCandidates: state.attemptedCandidates,
    fallbacksUsed: state.fallbacksUsed,
    fallbackPolicy: state.fallbackPolicy,
    ...(state.status === 'FALLBACK_ALLOCATING'
      ? { primaryFailureClass: state.primaryFailureClass }
      : {}),
    failureClass,
    reasonCodes,
  })
}

export function transitionFallbackState(
  rawState: FallbackState,
  rawEvent: z.input<typeof FallbackEventSchema>,
): FallbackState {
  const state = FallbackStateSchema.parse(rawState)
  const event = FallbackEventSchema.parse(rawEvent)

  if (state.status === 'REQUESTED') {
    if (event.type === 'ROUTE_SELECTED') {
      return FallbackStateSchema.parse({
        status: 'ROUTED',
        currentCandidate: event.candidate,
        attemptedCandidates: [event.candidate],
        fallbacksUsed: 0,
        fallbackPolicy: state.fallbackPolicy,
      })
    }
    if (event.type === 'ROUTE_FAILED') {
      return FallbackStateSchema.parse({
        status: 'FAILED',
        attemptedCandidates: [],
        fallbacksUsed: 0,
        fallbackPolicy: state.fallbackPolicy,
        failureClass: 'no_compatible_candidate',
        reasonCodes: ['FALLBACK_NOT_ELIGIBLE', 'NO_COMPATIBLE_RUNTIME'],
      })
    }
  }

  if (state.status === 'ROUTED' && event.type === 'ALLOCATION_STARTED') {
    return FallbackStateSchema.parse({ ...state, status: 'ALLOCATING' })
  }

  if (state.status === 'FALLBACK_ROUTED' && event.type === 'ALLOCATION_STARTED') {
    return FallbackStateSchema.parse({ ...state, status: 'FALLBACK_ALLOCATING' })
  }

  if (state.status === 'ALLOCATING') {
    if (event.type === 'ALLOCATION_SUCCEEDED') {
      return FallbackStateSchema.parse({
        status: 'ACTIVE',
        activeCandidate: state.currentCandidate,
        attemptedCandidates: state.attemptedCandidates,
        fallbacksUsed: state.fallbacksUsed,
        fallbackPolicy: state.fallbackPolicy,
      })
    }
    if (event.type === 'ALLOCATION_FAILED') {
      const classification = classifyFallbackFailure(event.failureClass)
      const fallbackCandidate = event.fallbackCandidate
      const canFallback =
        classification.eligible &&
        state.fallbackPolicy.allowed &&
        state.fallbackPolicy.maximumCrossRuntimeFallbacks === 1 &&
        fallbackCandidate !== undefined &&
        fallbackCandidate.candidateID !== state.currentCandidate.candidateID &&
        fallbackCandidate.runtimeClass !== state.currentCandidate.runtimeClass

      if (canFallback) {
        return FallbackStateSchema.parse({
          status: 'FALLBACK_ROUTED',
          originalCandidate: state.currentCandidate,
          currentCandidate: fallbackCandidate,
          attemptedCandidates: [state.currentCandidate, fallbackCandidate],
          fallbacksUsed: 1,
          fallbackPolicy: state.fallbackPolicy,
          primaryFailureClass: event.failureClass,
          reasonCodes: ['FALLBACK_ELIGIBLE', 'FALLBACK_FROM_RUNTIME'],
        })
      }

      const reasonCodes = !classification.eligible
        ? classification.reasonCodes
        : !state.fallbackPolicy.allowed
          ? (['FALLBACK_NOT_ELIGIBLE', 'FALLBACK_DISABLED'] as const)
          : fallbackCandidate === undefined
            ? (['FALLBACK_NOT_ELIGIBLE', 'FALLBACK_CANDIDATE_UNAVAILABLE'] as const)
            : (['FALLBACK_NOT_ELIGIBLE', 'FALLBACK_SAME_RUNTIME'] as const)
      return failedState(state, event.failureClass, reasonCodes)
    }
  }

  if (state.status === 'FALLBACK_ALLOCATING') {
    if (event.type === 'ALLOCATION_SUCCEEDED') {
      return FallbackStateSchema.parse({
        status: 'ACTIVE',
        activeCandidate: state.currentCandidate,
        attemptedCandidates: state.attemptedCandidates,
        fallbacksUsed: state.fallbacksUsed,
        fallbackPolicy: state.fallbackPolicy,
        primaryFailureClass: state.primaryFailureClass,
      })
    }
    if (event.type === 'ALLOCATION_FAILED') {
      return failedState(state, event.failureClass, [
        'FALLBACK_NOT_ELIGIBLE',
        'FALLBACK_LIMIT_REACHED',
      ])
    }
  }

  throw new Error(`Invalid fallback transition from ${state.status} using ${event.type}.`)
}
