import type { ControlPlaneConfig } from '@surfgate/config'
import type { ControlPlaneTelemetry } from '@surfgate/observability'
import {
  IdempotencyKeySchema,
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
  SessionGetResponseSchema,
  RelayTokenResponseSchema,
  SessionTerminationResponseSchema,
  SurfGateErrorCodeSchema,
  type SurfGateErrorCode,
  type RoutingDecisionID,
  type SessionCreateRequest,
  type SessionID,
} from '@surfgate/contracts'
import { ProviderError, type ProviderSession } from '@surfgate/provider-core'
import {
  classifyProviderErrorForFallback,
  routeBrowserRuntime,
  RoutingInputSchema,
  TenantRoutingPolicySchema,
  type RoutingCandidateIdentity,
  type RoutingDecision,
} from '@surfgate/router'

import type { AuthenticatedTenantContext } from '../auth/context.js'
import type { AllocationAttemptRepository } from '../domain/allocation-attempt.js'
import type { AuditEventRepository, AuditEventType } from '../domain/audit-event.js'
import type { SessionCreateCoordinator } from '../domain/idempotency.js'
import {
  generateOwnerToken,
  generateRoutingDecisionID,
  generateSessionID,
} from '../domain/opaque-id.js'
import { SessionSchema, type Session } from '../domain/session.js'
import { ControlPlaneHTTPError } from '../errors/http-error.js'
import type { ProviderRegistry } from '../providers/provider-registry.js'
import type { RequestRateLimiter } from '../quota/rate-limiter.js'
import { RateLimitDependencyError, RateLimitExceededError } from '../quota/rate-limiter.js'
import type { RoutingDecisionRepository } from '../repositories/routing-decision-repository.js'
import type { SessionRepository } from '../repositories/session-repository.js'
import { SessionTransitionConflictError } from '../repositories/session-repository.js'
import type { ProviderSessionReferenceProtector } from '../security/provider-session-reference.js'
import type { TargetPolicy } from '@surfgate/security'
import { TargetPolicyError, type RelayTokenService } from '@surfgate/security'
import type { RelayAuthorizationStore } from '../relay/relay-authorization.js'

import { hashIdempotentRequest } from './idempotency-hash.js'
import { toPublicSession } from './public-session.js'

export type SessionServiceDependencies = Readonly<{
  sessions: SessionRepository
  decisions: RoutingDecisionRepository
  attempts: AllocationAttemptRepository
  audit: AuditEventRepository
  coordinator: SessionCreateCoordinator
  rateLimiter: RequestRateLimiter
  targetPolicy: TargetPolicy
  registry: ProviderRegistry
  protector: ProviderSessionReferenceProtector
  config: ControlPlaneConfig
  ids?: Readonly<{
    session(): SessionID
    decision(): RoutingDecisionID
    ownerToken(): string
  }>
  now?: () => Date
  telemetry?: ControlPlaneTelemetry
  relay?: Readonly<{
    tokens: RelayTokenService
    authorization: RelayAuthorizationStore
    publicURL: URL
    tokenTTLSeconds: number
  }>
}>

function providerHTTPError(error: ProviderError): ControlPlaneHTTPError {
  switch (error.code) {
    case 'PROVIDER_AUTHORIZATION_ERROR':
    case 'PROVIDER_CONFIGURATION_ERROR':
      return new ControlPlaneHTTPError('PROVIDER_AUTHENTICATION_FAILED', 502)
    case 'PROVIDER_OPERATION_TIMEOUT':
      return new ControlPlaneHTTPError('PROVIDER_TIMEOUT', 504)
    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_CAPACITY_EXHAUSTED':
      return new ControlPlaneHTTPError('PROVIDER_RATE_LIMITED', 503)
    default:
      return new ControlPlaneHTTPError('PROVIDER_ALLOCATION_FAILED', 503)
  }
}

function normalizeCreateError(error: unknown): ControlPlaneHTTPError {
  if (error instanceof ControlPlaneHTTPError) return error
  if (error instanceof ProviderError) return providerHTTPError(error)
  if (error instanceof TargetPolicyError)
    return new ControlPlaneHTTPError('POLICY_TARGET_FORBIDDEN', 403)
  if (error instanceof RateLimitExceededError)
    return new ControlPlaneHTTPError('QUOTA_EXCEEDED', 429)
  if (error instanceof RateLimitDependencyError)
    return new ControlPlaneHTTPError('INTERNAL_DEPENDENCY_UNAVAILABLE', 503)
  return new ControlPlaneHTTPError('INTERNAL_ERROR', 500)
}

export class SessionService {
  readonly #dependencies: SessionServiceDependencies
  readonly #now: () => Date
  readonly #ids: NonNullable<SessionServiceDependencies['ids']>

  constructor(dependencies: SessionServiceDependencies) {
    this.#dependencies = dependencies
    this.#now = dependencies.now ?? (() => new Date())
    this.#ids = dependencies.ids ?? {
      session: generateSessionID,
      decision: generateRoutingDecisionID,
      ownerToken: generateOwnerToken,
    }
  }

  async create(
    context: AuthenticatedTenantContext,
    rawRequest: unknown,
    rawIdempotencyKey: string,
    signal?: AbortSignal,
  ) {
    const request = SessionCreateRequestSchema.parse(rawRequest)
    const key = IdempotencyKeySchema.parse(rawIdempotencyKey)
    const normalizedForClaim = SessionCreateRequestSchema.parse({
      ...request,
      ...(request.targetUrl === undefined ? {} : { targetUrl: new URL(request.targetUrl).href }),
    })
    const requestHash = hashIdempotentRequest(normalizedForClaim)
    const now = this.#now().toISOString()
    const ownerToken = this.#ids.ownerToken()
    const initial = SessionSchema.parse({
      id: this.#ids.session(),
      tenantID: context.tenantID,
      status: 'pending',
      requestedCapabilities: normalizedForClaim.capabilities,
      selectedRuntime: null,
      selectedProvider: null,
      providerSessionReferenceEncrypted: null,
      routingDecisionID: null,
      createdAt: now,
      updatedAt: now,
      connectedAt: null,
      expiresAt: null,
      terminatedAt: null,
      terminationReason: null,
      version: 0,
    })
    let claim = await this.#dependencies.coordinator.claim({
      tenantID: context.tenantID,
      key,
      requestHash,
      ownerToken,
      leaseExpiresAt: new Date(
        Date.parse(now) + this.#dependencies.config.idempotencyWaitTimeoutMs,
      ).toISOString(),
      session: initial,
      maxConcurrentSessions: this.#dependencies.config.quotas.maxConcurrentSessions,
    })
    if (claim.kind === 'conflict')
      throw new ControlPlaneHTTPError('VALIDATION_IDEMPOTENCY_CONFLICT', 409)
    if (claim.kind === 'quota_exceeded') {
      await this.#audit(context, 'quota.denied', now)
      throw new ControlPlaneHTTPError('QUOTA_CONCURRENT_SESSION_LIMIT', 429)
    }
    if (claim.kind === 'existing' && claim.state === 'in_progress') {
      claim = await this.#dependencies.coordinator.waitForCompletion({
        tenantID: context.tenantID,
        key,
        requestHash,
        timeoutMs: this.#dependencies.config.idempotencyWaitTimeoutMs,
      })
    }
    if (claim.kind === 'existing') {
      if (claim.state === 'in_progress') {
        throw new ControlPlaneHTTPError('INTERNAL_DEPENDENCY_UNAVAILABLE', 503)
      }
      if (claim.state === 'failed') {
        throw new ControlPlaneHTTPError(
          SurfGateErrorCodeSchema.parse(claim.errorCode),
          claim.httpStatus ?? 500,
        )
      }
      return SessionCreateResponseSchema.parse({ session: await this.#public(claim.session) })
    }
    if (claim.kind !== 'owner') throw new ControlPlaneHTTPError('INTERNAL_ERROR', 500)

    let session = claim.session
    try {
      await this.#audit(context, 'session.create.requested', now, session.id)
      if (
        normalizedForClaim.maxDurationSeconds >
        this.#dependencies.config.quotas.maxSessionDurationSeconds
      ) {
        await this.#audit(context, 'quota.denied', this.#now().toISOString(), session.id)
        throw new ControlPlaneHTTPError('QUOTA_EXCEEDED', 429)
      }
      const quotaStarted = performance.now()
      try {
        await this.#dependencies.rateLimiter.check(
          context.tenantID,
          this.#dependencies.config.quotas.requestsPerMinute,
        )
      } catch (error: unknown) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'QUOTA_EXCEEDED'
        ) {
          await this.#audit(context, 'quota.denied', this.#now().toISOString(), session.id)
        }
        throw error
      }
      this.#recordOperation({
        operation: 'surfgate.quota.check',
        outcome: 'success',
        durationMs: Math.max(0, performance.now() - quotaStarted),
      })
      let targetURL: string | undefined
      try {
        targetURL =
          normalizedForClaim.targetUrl === undefined
            ? undefined
            : await this.#dependencies.targetPolicy.validate(normalizedForClaim.targetUrl)
      } catch (error: unknown) {
        await this.#audit(context, 'policy.denied', this.#now().toISOString(), session.id)
        throw error
      }
      const normalizedRequest = SessionCreateRequestSchema.parse({
        ...normalizedForClaim,
        ...(targetURL === undefined ? {} : { targetUrl: targetURL }),
      })
      session = await this.#transition(session, { type: 'begin_routing', at: now })
      const sources = await this.#dependencies.registry.routingSources({
        timeoutMs: this.#dependencies.config.healthTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
      const routingStarted = performance.now()
      const decision = routeBrowserRuntime(
        RoutingInputSchema.parse({
          decisionID: this.#ids.decision(),
          tenantID: context.tenantID,
          requestID: context.requestID,
          createdAt: now,
          capabilityRegistryVersion: 'capabilities-v1',
          requirements: normalizedRequest.capabilities,
          runtime: normalizedRequest.runtime,
          maxSessionDurationMs: normalizedRequest.maxDurationSeconds * 1_000,
          tenantPolicy: TenantRoutingPolicySchema.parse({
            preferredRuntime: normalizedRequest.runtime.preference,
            allowFallback: normalizedRequest.runtime.allowFallback,
            allowExperimental: normalizedRequest.runtime.allowExperimental,
            maximumSessionDurationMs:
              this.#dependencies.config.quotas.maxSessionDurationSeconds * 1_000,
          }),
          candidateSources: sources,
        }),
      )
      this.#recordOperation({
        operation: 'surfgate.routing.decide',
        outcome: 'success',
        durationMs: Math.max(0, performance.now() - routingStarted),
        ...(decision.selectedCandidate === null
          ? {}
          : {
              runtimeClass: decision.selectedCandidate.runtimeClass,
              providerID: decision.selectedCandidate.providerID,
            }),
      })
      await this.#dependencies.decisions.saveRoutingDecisionForTenant({
        tenantID: context.tenantID,
        sessionID: session.id,
        decision,
      })
      await this.#audit(context, 'routing.decision', now, session.id, {
        outcome: decision.outcome,
        policyVersion: decision.policyVersion,
      })
      if (decision.selectedCandidate === null) {
        session = await this.#transition(session, {
          type: 'fail',
          at: now,
          reason: 'no_compatible_runtime',
        })
        throw new ControlPlaneHTTPError('ROUTING_NO_COMPATIBLE_RUNTIME', 422)
      }
      session = await this.#transition(session, {
        type: 'begin_allocation',
        at: now,
        selectedRuntime: decision.selectedCandidate.runtimeClass,
        selectedProvider: decision.selectedCandidate.providerID,
        routingDecisionID: decision.decisionID,
      })
      const active = await this.#allocateWithFallback(
        context,
        session,
        decision,
        normalizedRequest,
        targetURL,
        signal,
      )
      await this.#audit(context, 'session.create.succeeded', this.#now().toISOString(), active.id)
      await this.#dependencies.coordinator.complete({
        tenantID: context.tenantID,
        key,
        ownerToken,
        sessionID: active.id,
        state: 'succeeded',
        httpStatus: 201,
        at: this.#now().toISOString(),
      })
      return SessionCreateResponseSchema.parse({ session: await this.#public(active, decision) })
    } catch (error: unknown) {
      const publicError = normalizeCreateError(error)
      const current = await this.#dependencies.sessions.findSessionForTenant(
        context.tenantID,
        session.id,
      )
      if (current !== null && !['terminated', 'expired', 'failed'].includes(current.status)) {
        if (current.status === 'active' || current.status === 'terminating') {
          session = await this.#cleanupPersisted(current)
        } else {
          session = await this.#transition(current, {
            type: 'fail',
            at: this.#now().toISOString(),
            reason: 'allocation_failed',
          }).catch(() => current)
        }
      } else if (current !== null) {
        session = current
      }
      await this.#completeFailure(
        context,
        key,
        ownerToken,
        session,
        publicError.code,
        publicError.statusCode,
      )
      throw publicError
    }
  }

  async get(context: AuthenticatedTenantContext, sessionID: SessionID) {
    const session = await this.#dependencies.sessions.findSessionForTenant(
      context.tenantID,
      sessionID,
    )
    if (session === null) throw new ControlPlaneHTTPError('SESSION_NOT_FOUND', 404)
    return SessionGetResponseSchema.parse({ session: await this.#public(session) })
  }

  async issueRelayToken(context: AuthenticatedTenantContext, sessionID: SessionID) {
    const session = await this.#dependencies.sessions.findSessionForTenant(
      context.tenantID,
      sessionID,
    )
    if (session === null) throw new ControlPlaneHTTPError('SESSION_NOT_FOUND', 404)
    const relay = this.#dependencies.relay
    if (relay === undefined) {
      throw new ControlPlaneHTTPError('INTERNAL_DEPENDENCY_UNAVAILABLE', 503)
    }
    const nowMs = this.#now().getTime()
    const expiresAtMs = session.expiresAt === null ? Number.NaN : Date.parse(session.expiresAt)
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new ControlPlaneHTTPError('SESSION_EXPIRED', 409)
    }
    if (session.status !== 'active') {
      throw new ControlPlaneHTTPError('SESSION_NOT_ACTIVE', 409)
    }
    try {
      if (await relay.authorization.isSessionRevoked(context.tenantID, session.id)) {
        throw new ControlPlaneHTTPError('SESSION_NOT_ACTIVE', 409)
      }
    } catch (error: unknown) {
      if (error instanceof ControlPlaneHTTPError) throw error
      throw new ControlPlaneHTTPError('INTERNAL_DEPENDENCY_UNAVAILABLE', 503)
    }
    const remainingSeconds = Math.floor((expiresAtMs - nowMs) / 1_000)
    if (!Number.isFinite(remainingSeconds) || remainingSeconds < 1) {
      throw new ControlPlaneHTTPError('SESSION_EXPIRED', 409)
    }
    const issued = relay.tokens.issue({
      tenantID: context.tenantID,
      sessionID: session.id,
      ttlSeconds: Math.min(relay.tokenTTLSeconds, remainingSeconds),
    })
    const webSocketURL = new URL(`/v1/sessions/${session.id}/cdp`, relay.publicURL)
    await this.#audit(context, 'relay.token.issued', this.#now().toISOString(), session.id)
    return RelayTokenResponseSchema.parse({
      webSocketUrl: webSocketURL.href,
      token: issued.token,
      expiresAt: issued.expiresAt,
    })
  }

  async terminate(context: AuthenticatedTenantContext, sessionID: SessionID, signal?: AbortSignal) {
    let session = await this.#dependencies.sessions.findSessionForTenant(
      context.tenantID,
      sessionID,
    )
    if (session === null) throw new ControlPlaneHTTPError('SESSION_NOT_FOUND', 404)
    if (['terminated', 'expired', 'failed'].includes(session.status)) {
      return SessionTerminationResponseSchema.parse({ session: await this.#public(session) })
    }
    const at = this.#now().toISOString()
    session = await this.#transition(session, { type: 'request_termination', at })
    await this.#audit(context, 'session.terminate.requested', at, session.id)
    const terminatingSessionID = session.id
    if (this.#dependencies.relay !== undefined) {
      await this.#dependencies.relay.authorization
        .revokeSession({
          tenantID: context.tenantID,
          sessionID: terminatingSessionID,
          ttlSeconds: 300,
        })
        .then(() =>
          this.#audit(
            context,
            'relay.session.revoked',
            this.#now().toISOString(),
            terminatingSessionID,
          ),
        )
        .catch(() => undefined)
    }
    try {
      if (session.providerSessionReferenceEncrypted === null) throw new Error('missing reference')
      const protectedSession = this.#dependencies.protector.decrypt(
        session.providerSessionReferenceEncrypted,
        { tenantID: context.tenantID, sessionID: session.id },
      )
      const provider = this.#dependencies.registry.resolve(protectedSession.candidate)
      const terminationStarted = performance.now()
      await provider.terminate(protectedSession.session.reference, {
        timeoutMs: this.#dependencies.config.terminationTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
      this.#recordOperation({
        operation: 'surfgate.provider.terminate',
        outcome: 'success',
        durationMs: Math.max(0, performance.now() - terminationStarted),
        runtimeClass: protectedSession.session.reference.runtimeClass,
        providerID: protectedSession.session.reference.providerID,
      })
      try {
        session = await this.#transition(session, {
          type: 'complete_termination',
          at: this.#now().toISOString(),
          reason: 'client_requested',
        })
      } catch (error: unknown) {
        if (!(error instanceof SessionTransitionConflictError)) throw error
        const current = await this.#dependencies.sessions.findSessionForTenant(
          context.tenantID,
          session.id,
        )
        if (current === null || current.status !== 'terminated') throw error
        session = current
      }
      await this.#audit(context, 'session.terminated', this.#now().toISOString(), session.id)
      return SessionTerminationResponseSchema.parse({ session: await this.#public(session) })
    } catch (error: unknown) {
      await this.#audit(context, 'session.terminate.failed', this.#now().toISOString(), session.id)
      throw error instanceof ProviderError
        ? providerHTTPError(error)
        : new ControlPlaneHTTPError('PROVIDER_UPSTREAM_ERROR', 503)
    }
  }

  async #allocateWithFallback(
    context: AuthenticatedTenantContext,
    session: Session,
    decision: RoutingDecision,
    request: SessionCreateRequest,
    targetURL: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Session> {
    const selected = decision.selectedCandidate!
    try {
      return await this.#allocate(
        context,
        session,
        selected,
        0,
        request,
        targetURL,
        signal,
        decision,
      )
    } catch (error: unknown) {
      if (!(error instanceof ProviderError)) throw error
      const classification = classifyProviderErrorForFallback(error.code, 'allocate')
      await this.#dependencies.attempts.complete({
        tenantID: context.tenantID,
        sessionID: session.id,
        attemptNumber: 0,
        status: 'failed',
        failureClass: classification.failureClass,
        fallbackEligible: classification.eligible,
        reasonCodes: classification.reasonCodes,
        at: this.#now().toISOString(),
      })
      const fallback = decision.eligibleCandidates
        .map((candidate) => candidate.candidate)
        .find((candidate) => candidate.runtimeClass !== selected.runtimeClass)
      if (!classification.eligible || !decision.fallbackPolicy.allowed || fallback === undefined)
        throw error
      const fallbackAt = this.#now().toISOString()
      session = await this.#transition(session, {
        type: 'begin_fallback_allocation',
        at: fallbackAt,
        selectedRuntime: fallback.runtimeClass,
        selectedProvider: fallback.providerID,
        routingDecisionID: decision.decisionID,
      })
      await this.#audit(context, 'routing.fallback', fallbackAt, session.id, {
        failureClass: classification.failureClass,
        fallbackRuntime: fallback.runtimeClass,
      })
      try {
        return await this.#allocate(
          context,
          session,
          fallback,
          1,
          request,
          targetURL,
          signal,
          decision,
        )
      } catch (fallbackError: unknown) {
        if (fallbackError instanceof ProviderError) {
          const fallbackClassification = classifyProviderErrorForFallback(
            fallbackError.code,
            'allocate',
          )
          await this.#dependencies.attempts.complete({
            tenantID: context.tenantID,
            sessionID: session.id,
            attemptNumber: 1,
            status: 'failed',
            failureClass: fallbackClassification.failureClass,
            fallbackEligible: false,
            reasonCodes: ['FALLBACK_LIMIT_REACHED'],
            at: this.#now().toISOString(),
          })
        }
        throw fallbackError
      }
    }
  }

  async #allocate(
    context: AuthenticatedTenantContext,
    session: Session,
    candidate: RoutingCandidateIdentity,
    attemptNumber: 0 | 1,
    request: SessionCreateRequest,
    targetURL: string | undefined,
    signal: AbortSignal | undefined,
    decision: RoutingDecision,
  ): Promise<Session> {
    const validatedTargetURL =
      targetURL === undefined
        ? undefined
        : await this.#dependencies.targetPolicy.validate(targetURL)
    const at = this.#now().toISOString()
    await this.#dependencies.attempts.start({
      tenantID: context.tenantID,
      sessionID: session.id,
      attemptNumber,
      candidate,
      at,
    })
    const provider = this.#dependencies.registry.resolve(candidate)
    const allocationStarted = performance.now()
    const providerSession = await provider.allocate(
      {
        requestID: context.requestID,
        runtimeClass: candidate.runtimeClass,
        requirements: request.capabilities,
        allowExperimental: request.runtime.allowExperimental,
        maxSessionDurationMs: request.maxDurationSeconds * 1_000,
        ...(validatedTargetURL === undefined ? {} : { targetURL: validatedTargetURL }),
        ...(candidate.region === undefined ? {} : { region: candidate.region }),
        ...(candidate.configProfile === undefined
          ? {}
          : { configProfile: candidate.configProfile }),
        metadata: { operationName: 'provider.allocate' },
      },
      {
        timeoutMs: this.#dependencies.config.allocationTimeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
    )
    let encrypted: string | undefined
    try {
      encrypted = this.#dependencies.protector.encrypt(providerSession, candidate, {
        tenantID: context.tenantID,
        sessionID: session.id,
      })
      this.#recordOperation({
        operation: 'surfgate.provider.allocate',
        outcome: 'success',
        durationMs: Math.max(0, performance.now() - allocationStarted),
        runtimeClass: candidate.runtimeClass,
        providerID: candidate.providerID,
      })
      const active = await this.#transition(session, {
        type: 'activate',
        at: this.#now().toISOString(),
        expiresAt: providerSession.expiresAt,
        providerSessionReferenceEncrypted: encrypted,
      })
      await this.#dependencies.attempts.complete({
        tenantID: context.tenantID,
        sessionID: session.id,
        attemptNumber,
        status: 'succeeded',
        reasonCodes: decision.reasonCodes,
        at: this.#now().toISOString(),
      })
      return active
    } catch (error: unknown) {
      await this.#recoverAllocatedSession(session, providerSession, provider, encrypted)
      throw error
    }
  }

  async #cleanup(
    session: ProviderSession,
    provider: ReturnType<ProviderRegistry['resolve']>,
  ): Promise<boolean> {
    try {
      await provider.terminate(session.reference, {
        timeoutMs: this.#dependencies.config.terminationTimeoutMs,
      })
      return true
    } catch {
      return false
    }
  }

  async #cleanupPersisted(session: Session): Promise<Session> {
    if (session.providerSessionReferenceEncrypted === null) return session
    try {
      const protectedSession = this.#dependencies.protector.decrypt(
        session.providerSessionReferenceEncrypted,
        { tenantID: session.tenantID, sessionID: session.id },
      )
      const provider = this.#dependencies.registry.resolve(protectedSession.candidate)
      let current = session
      if (current.status === 'active') {
        current = await this.#transition(current, {
          type: 'request_termination',
          at: this.#now().toISOString(),
        })
      }
      if (await this.#cleanup(protectedSession.session, provider)) {
        current = await this.#transition(current, {
          type: 'complete_termination',
          at: this.#now().toISOString(),
          reason: 'creation_rollback',
        })
      }
      return current
    } catch {
      // The protected reference remains durable for reconciliation.
      return session
    }
  }

  async #recoverAllocatedSession(
    original: Session,
    providerSession: ProviderSession,
    provider: ReturnType<ProviderRegistry['resolve']>,
    encrypted: string | undefined,
  ): Promise<void> {
    let recoverable: Session | null = null
    if (encrypted !== undefined) {
      try {
        const current = await this.#dependencies.sessions.findSessionForTenant(
          original.tenantID,
          original.id,
        )
        if (current !== null) {
          if (current.status === 'active') {
            recoverable = await this.#transition(current, {
              type: 'request_termination',
              at: this.#now().toISOString(),
            })
          } else if (current.status === 'allocating' || current.status === 'fallback_allocating') {
            recoverable = await this.#transition(current, {
              type: 'retain_for_cleanup',
              at: this.#now().toISOString(),
              expiresAt: providerSession.expiresAt,
              providerSessionReferenceEncrypted: encrypted,
            })
          } else if (current.status === 'terminating') {
            recoverable = current
          }
        }
      } catch {
        // Cleanup is still attempted; a durable allocation attempt remains for reconciliation.
      }
    }
    const cleaned = await this.#cleanup(providerSession, provider)
    if (cleaned && recoverable?.status === 'terminating') {
      await this.#transition(recoverable, {
        type: 'complete_termination',
        at: this.#now().toISOString(),
        reason: 'creation_rollback',
      }).catch(() => undefined)
    }
  }

  async #transition(
    session: Session,
    event: Parameters<SessionRepository['transitionSessionForTenant']>[0]['event'],
  ): Promise<Session> {
    return this.#dependencies.sessions.transitionSessionForTenant({
      tenantID: session.tenantID,
      sessionID: session.id,
      expectedVersion: session.version,
      event,
    })
  }

  async #public(session: Session, knownDecision?: RoutingDecision) {
    const decision =
      knownDecision ??
      (session.routingDecisionID === null
        ? null
        : await this.#dependencies.decisions.findRoutingDecisionForTenant(
            session.tenantID,
            session.routingDecisionID,
          ))
    const attempts = await this.#dependencies.attempts.countForSession(session.tenantID, session.id)
    return toPublicSession(session, decision, attempts)
  }

  async #audit(
    context: AuthenticatedTenantContext,
    type: AuditEventType,
    createdAt: string,
    sessionID?: SessionID,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#dependencies.audit.append({
      tenantID: context.tenantID,
      type,
      requestID: context.requestID,
      apiKeyID: context.apiKeyID,
      ...(sessionID === undefined ? {} : { sessionID }),
      ...(metadata === undefined ? {} : { metadata }),
      createdAt,
    })
  }

  async #completeFailure(
    context: AuthenticatedTenantContext,
    key: string,
    ownerToken: string,
    session: Session,
    errorCode: SurfGateErrorCode,
    httpStatus: number,
  ): Promise<void> {
    const at = this.#now().toISOString()
    await this.#dependencies.coordinator.complete({
      tenantID: context.tenantID,
      key,
      ownerToken,
      sessionID: session.id,
      state: 'failed',
      httpStatus,
      errorCode,
      at,
    })
    await this.#audit(context, 'session.create.failed', at, session.id, { errorCode }).catch(
      () => undefined,
    )
  }

  #recordOperation(
    operation: Parameters<NonNullable<ControlPlaneTelemetry['recordOperation']>>[0],
  ): void {
    try {
      this.#dependencies.telemetry?.recordOperation?.(operation)
    } catch {
      // Telemetry must never alter lifecycle correctness.
    }
  }
}
