import { CAPABILITY_NAMES, type CapabilityName } from '@surfgate/contracts'

import type { RoutingCandidate } from './candidate.js'
import type { RoutingReasonCode } from './reason-code.js'
import type { RoutingInput } from './routing-input.js'

export type CandidateEligibility =
  | Readonly<{
      eligible: true
      candidate: RoutingCandidate
      reasonCodes: readonly RoutingReasonCode[]
    }>
  | Readonly<{
      eligible: false
      candidate: RoutingCandidate
      reasonCodes: readonly RoutingReasonCode[]
    }>

const SPECIALIZED_CAPABILITY_REASONS: Readonly<Partial<Record<CapabilityName, RoutingReasonCode>>> =
  Object.freeze({
    webgl: 'REQUIRES_WEBGL',
    video: 'REQUIRES_VIDEO',
    persistentAuth: 'REQUIRES_PERSISTENT_AUTH',
    realBrowserTLS: 'REQUIRES_REAL_BROWSER_TLS',
  })

function includes<Value>(values: readonly Value[] | undefined, value: Value): boolean {
  return values?.includes(value) ?? false
}

function isAllowed<Value>(allowlist: readonly Value[] | undefined, value: Value): boolean {
  return allowlist === undefined || allowlist.includes(value)
}

function addReason(reasons: RoutingReasonCode[], reason: RoutingReasonCode): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason)
  }
}

export function evaluateCandidateEligibility(
  candidate: RoutingCandidate,
  input: RoutingInput,
): CandidateEligibility {
  const rejectionReasons: RoutingReasonCode[] = []
  const eligibleContextReasons: RoutingReasonCode[] = []
  const effectiveAllowFallback = input.runtime.allowFallback && input.tenantPolicy.allowFallback
  const effectiveAllowExperimental =
    input.runtime.allowExperimental && input.tenantPolicy.allowExperimental

  if (!candidate.configured) {
    addReason(rejectionReasons, 'CANDIDATE_NOT_CONFIGURED')
  } else if (candidate.health.status === 'unavailable') {
    addReason(rejectionReasons, 'CANDIDATE_UNHEALTHY')
  } else if (candidate.health.status === 'degraded') {
    if (input.tenantPolicy.allowDegradedProviders) {
      addReason(eligibleContextReasons, 'CANDIDATE_DEGRADED')
    } else {
      addReason(rejectionReasons, 'CANDIDATE_DEGRADED')
    }
  }

  if (candidate.health.capacity === 'exhausted') {
    addReason(rejectionReasons, 'PROVIDER_CAPACITY_EXHAUSTED')
  }

  if (
    !isAllowed(input.tenantPolicy.allowedProviderIDs, candidate.providerID) ||
    includes(input.tenantPolicy.deniedProviderIDs, candidate.providerID)
  ) {
    addReason(rejectionReasons, 'CANDIDATE_FORBIDDEN_BY_POLICY')
  }

  if (
    !isAllowed(input.tenantPolicy.allowedRuntimeClasses, candidate.runtimeClass) ||
    includes(input.tenantPolicy.deniedRuntimeClasses, candidate.runtimeClass)
  ) {
    addReason(rejectionReasons, 'RUNTIME_FORBIDDEN_BY_POLICY')
  }

  if (
    input.runtime.preference !== 'auto' &&
    !effectiveAllowFallback &&
    candidate.runtimeClass !== input.runtime.preference
  ) {
    addReason(rejectionReasons, 'RUNTIME_PREFERENCE_REQUIRED')
  }

  if (candidate.safety.status === 'blocked') {
    addReason(rejectionReasons, 'CANDIDATE_BLOCKED_BY_SAFETY')
  }

  const maximumDuration = Math.min(
    candidate.safety.maximumSessionDurationMs ?? Number.POSITIVE_INFINITY,
    input.tenantPolicy.maximumSessionDurationMs ?? Number.POSITIVE_INFINITY,
  )
  if (input.maxSessionDurationMs > maximumDuration) {
    addReason(rejectionReasons, 'SESSION_DURATION_UNSUPPORTED')
  }

  for (const capability of CAPABILITY_NAMES) {
    if (input.requirements[capability] !== 'required') {
      continue
    }

    const support = candidate.capabilities[capability]
    if (support === 'supported' || (support === 'experimental' && effectiveAllowExperimental)) {
      continue
    }

    const specializedReason = SPECIALIZED_CAPABILITY_REASONS[capability]
    if (specializedReason !== undefined) {
      addReason(rejectionReasons, specializedReason)
    }
    if (support === 'unsupported') {
      addReason(rejectionReasons, 'REQUIRED_CAPABILITY_UNSUPPORTED')
    } else if (support === 'unknown') {
      addReason(rejectionReasons, 'CAPABILITY_UNKNOWN')
    } else {
      addReason(rejectionReasons, 'CAPABILITY_EXPERIMENTAL_NOT_ALLOWED')
    }
  }

  if (rejectionReasons.length > 0) {
    return Object.freeze({
      eligible: false,
      candidate,
      reasonCodes: Object.freeze(rejectionReasons),
    })
  }

  const eligibleReasons: RoutingReasonCode[] = ['CAPABILITIES_SATISFIED', ...eligibleContextReasons]
  return Object.freeze({
    eligible: true,
    candidate,
    reasonCodes: Object.freeze(eligibleReasons),
  })
}
