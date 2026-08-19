import { describe, expect, it, vi } from 'vitest'

import {
  RequestIDSchema,
  TenantIDSchema,
  APIKeyIDSchema,
  SessionIDSchema,
  RoutingDecisionIDSchema,
  RelayTokenSchema,
} from '@surfgate/contracts'
import { ProviderDescriptorSchema } from '@surfgate/provider-core'
import {
  FakeBrowserProvider,
  createFakeProviderConfig,
  createFakeProviderDescriptor,
} from '@surfgate/testing'

import type { AuthenticatedTenantContext } from '../../src/auth/context.js'
import { applySessionTransition, type Session } from '../../src/domain/session.js'
import { ProviderRegistry } from '../../src/providers/provider-registry.js'
import { SessionService } from '../../src/services/session-service.js'
import { RateLimitDependencyError, RateLimitExceededError } from '../../src/quota/rate-limiter.js'
import { TargetPolicyError } from '@surfgate/security'
import type { ProtectedProviderSession } from '@surfgate/security'

const context: AuthenticatedTenantContext = Object.freeze({
  tenantID: TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  apiKeyID: APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  requestID: RequestIDSchema.parse('req_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  scopes: ['sessions:write', 'sessions:read', 'sessions:terminate', 'sessions:connect'],
})
const otherTenantContext: AuthenticatedTenantContext = Object.freeze({
  ...context,
  tenantID: TenantIDSchema.parse('ten_01BX5ZZKBKACTAV9WEVGEMMVRY'),
})

function provider(
  runtimeClass: 'kitesurf' | 'chromium',
  behavior: 'success' | 'transient_failure' | 'authorization_error' = 'success',
) {
  const base = createFakeProviderDescriptor()
  return new FakeBrowserProvider(
    createFakeProviderConfig({
      descriptor: ProviderDescriptorSchema.parse({
        ...base,
        runtimeClass,
        configProfile: runtimeClass,
        capabilities: {
          ...base.capabilities,
          webgl: runtimeClass === 'chromium' ? 'supported' : 'unsupported',
        },
      }),
      allocation: { behavior },
      nowEpochMs: Date.parse('2026-08-09T00:00:00.000Z'),
    }),
  )
}

function fixture(
  kitesurfBehavior: 'success' | 'transient_failure' | 'authorization_error' = 'success',
  options: Readonly<{
    failActivationAndRecoveryRead?: boolean
    failFirstAudit?: boolean
    requestFailure?: 'rate_limit' | 'redis' | 'target'
    rawCDPAccess?: 'disabled' | 'trusted'
    withoutRelay?: boolean
  }> = {},
) {
  let session: Session | undefined
  let decision: unknown
  let claimState: 'new' | 'in_progress' | 'succeeded' | 'failed' = 'new'
  let claimHTTPStatus: number | null = null
  let claimErrorCode: string | null = null
  let rateLimitChecks = 0
  let recoveryReadShouldFail = false
  let auditWrites = 0
  let targetPolicyChecks = 0
  const isSessionRevoked = vi.fn(() => Promise.resolve(false))
  const revokeSession = vi.fn(() => Promise.resolve())
  let protectedProviderSession: ProtectedProviderSession | undefined
  const attempts: Array<{ attemptNumber: number; status?: string }> = []
  const sessions = {
    insertSession: (value: Session) => Promise.resolve((session = value)),
    findSessionForTenant: (tenantID: AuthenticatedTenantContext['tenantID']) => {
      if (recoveryReadShouldFail) {
        recoveryReadShouldFail = false
        return Promise.reject(new Error('database unavailable'))
      }
      return Promise.resolve(session?.tenantID === tenantID ? session : null)
    },
    transitionSessionForTenant: (
      input: Parameters<typeof applySessionTransition>[1] extends never
        ? never
        : { event: Parameters<typeof applySessionTransition>[1] },
    ) => {
      if (input.event.type === 'activate' && options.failActivationAndRecoveryRead === true) {
        recoveryReadShouldFail = true
        return Promise.reject(new Error('active persistence failed'))
      }
      session = applySessionTransition(session!, input.event)
      return Promise.resolve(session)
    },
  }
  const kitesurf = provider('kitesurf', kitesurfBehavior)
  const chromium = provider('chromium')
  const service = new SessionService({
    sessions,
    decisions: {
      saveRoutingDecisionForTenant: (input) => Promise.resolve((decision = input.decision)),
      findRoutingDecisionForTenant: () => Promise.resolve(decision as never),
    },
    attempts: {
      start: (input) => {
        attempts.push({ attemptNumber: input.attemptNumber })
        return Promise.resolve()
      },
      complete: (input) => {
        attempts[input.attemptNumber]!.status = input.status
        return Promise.resolve()
      },
      countForSession: () => Promise.resolve(attempts.length),
    },
    audit: {
      append: () => {
        auditWrites += 1
        return options.failFirstAudit === true && auditWrites === 1
          ? Promise.reject(new Error('audit unavailable'))
          : Promise.resolve()
      },
    },
    coordinator: {
      claim: (input) => {
        if (claimState !== 'new') {
          return Promise.resolve({
            kind: 'existing' as const,
            session: session!,
            state: claimState,
            httpStatus: claimHTTPStatus,
            errorCode: claimErrorCode,
          })
        }
        session = input.session
        claimState = 'in_progress'
        return Promise.resolve({ kind: 'owner' as const, session })
      },
      complete: (input) => {
        claimState = input.state
        claimHTTPStatus = input.httpStatus
        claimErrorCode = input.errorCode ?? null
        return Promise.resolve()
      },
      waitForCompletion: () => {
        const state: 'in_progress' | 'succeeded' | 'failed' =
          claimState === 'new' ? 'in_progress' : claimState
        return Promise.resolve({
          kind: 'existing' as const,
          session: session!,
          state,
          httpStatus: claimHTTPStatus,
          errorCode: claimErrorCode,
        })
      },
    },
    rateLimiter: {
      check: () => {
        rateLimitChecks += 1
        if (options.requestFailure === 'rate_limit')
          return Promise.reject(new RateLimitExceededError())
        if (options.requestFailure === 'redis')
          return Promise.reject(new RateLimitDependencyError())
        return Promise.resolve()
      },
    },
    targetPolicy: {
      validate: (target) => {
        targetPolicyChecks += 1
        return options.requestFailure === 'target'
          ? Promise.reject(new TargetPolicyError())
          : Promise.resolve(target)
      },
    },
    registry: new ProviderRegistry([kitesurf, chromium]),
    protector: {
      encrypt: (providerSession, candidate) => {
        protectedProviderSession = { session: providerSession, candidate }
        return 'psr.v1.v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA'
      },
      decrypt: () => {
        if (protectedProviderSession === undefined) throw new Error('missing protected session')
        return protectedProviderSession
      },
    },
    config: {
      healthTimeoutMs: 100,
      allocationTimeoutMs: 100,
      terminationTimeoutMs: 100,
      idempotencyWaitTimeoutMs: 100,
      reconciliationBatchSize: 10,
      reconciliationStaleAfterMs: 30_000,
      quotas: { requestsPerMinute: 10, maxConcurrentSessions: 2, maxSessionDurationSeconds: 600 },
    },
    ids: {
      session: () => SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
      decision: () => RoutingDecisionIDSchema.parse('rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
      ownerToken: () => 'A'.repeat(32),
    },
    now: () => new Date('2026-08-09T00:00:00.000Z'),
    ...(options.withoutRelay === true
      ? {}
      : {
          relay: {
            tokens: {
              issue: () => ({
                token: RelayTokenSchema.parse(`sgrt.v1.v1.${'A'.repeat(64)}.${'B'.repeat(43)}`),
                expiresAt: '2026-08-09T00:01:00.000Z',
              }),
              verify: () => {
                throw new Error('not used by the API')
              },
            },
            authorization: { isSessionRevoked, revokeSession },
            publicURL: new URL('ws://127.0.0.1:8081'),
            tokenTTLSeconds: 60,
            rawCDPAccess: options.rawCDPAccess ?? 'trusted',
          },
        }),
  })
  return {
    service,
    attempts,
    get session() {
      return session
    },
    get rateLimitChecks() {
      return rateLimitChecks
    },
    get targetPolicyChecks() {
      return targetPolicyChecks
    },
    replaceSessionForTest(value: Session): void {
      session = value
    },
    kitesurf,
    isSessionRevoked,
    revokeSession,
  }
}

describe('SessionService', () => {
  it('routes and allocates a provider-neutral active session', async () => {
    const setup = fixture()
    const result = await setup.service.create(context, {}, 'create-1')
    expect(result.session).toMatchObject({
      status: 'active',
      runtime: { runtimeClass: 'kitesurf' },
    })
    expect(JSON.stringify(result)).not.toContain('websocket')
    expect(JSON.stringify(result)).not.toContain('psr.v1')
  })

  it('revalidates a target immediately before provider allocation', async () => {
    const setup = fixture()

    await setup.service.create(
      context,
      { targetUrl: 'https://example.com/path' },
      'target-revalidation',
    )

    expect(setup.targetPolicyChecks).toBe(2)
  })

  it('issues only a short-lived SurfGate relay credential for an active tenant session', async () => {
    const setup = fixture()
    const created = await setup.service.create(context, {}, 'relay-token-session')
    const response = await setup.service.issueRelayToken(context, created.session.id)

    expect(response).toMatchObject({
      webSocketUrl: `ws://127.0.0.1:8081/v1/sessions/${created.session.id}/cdp`,
      expiresAt: '2026-08-09T00:01:00.000Z',
    })
    expect(response.token).not.toContain('cloudflare')
    expect(setup.isSessionRevoked).toHaveBeenCalledWith(context.tenantID, created.session.id)
  })

  it('fails closed when raw CDP access is disabled by production policy', async () => {
    const setup = fixture('success', { rawCDPAccess: 'disabled' })
    const created = await setup.service.create(context, {}, 'relay-disabled')

    await expect(setup.service.issueRelayToken(context, created.session.id)).rejects.toMatchObject({
      code: 'POLICY_RAW_CDP_DISABLED',
      statusCode: 403,
    })
    expect(setup.isSessionRevoked).not.toHaveBeenCalled()
  })

  it('returns tenant-safe not-found before exposing relay dependency state', async () => {
    const setup = fixture('success', { withoutRelay: true })
    const created = await setup.service.create(context, {}, 'tenant-safe-relay-token')

    await expect(
      setup.service.issueRelayToken(otherTenantContext, created.session.id),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', statusCode: 404 })
  })

  it('fails closed when an active relay session has no finite expiry', async () => {
    const setup = fixture()
    const created = await setup.service.create(context, {}, 'relay-token-invalid-expiry')
    setup.replaceSessionForTest({ ...setup.session, expiresAt: null } as unknown as Session)

    await expect(setup.service.issueRelayToken(context, created.session.id)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
      statusCode: 409,
    })
  })

  it('publishes relay revocation before completing provider termination', async () => {
    const setup = fixture()
    const created = await setup.service.create(context, {}, 'terminate-relay-session')
    const terminated = await setup.service.terminate(context, created.session.id)

    expect(terminated.session.status).toBe('terminated')
    expect(setup.revokeSession).toHaveBeenCalledWith({
      tenantID: context.tenantID,
      sessionID: created.session.id,
      ttlSeconds: 300,
    })
  })

  it('replays a completed request before consuming quota or repeating allocation', async () => {
    const setup = fixture()
    const first = await setup.service.create(context, {}, 'stable-replay')
    const replay = await setup.service.create(context, {}, 'stable-replay')

    expect(replay).toEqual(first)
    expect(setup.rateLimitChecks).toBe(1)
    expect(setup.attempts).toHaveLength(1)
  })

  it('durably finalizes an owner reservation when the requested audit write fails', async () => {
    const setup = fixture('success', { failFirstAudit: true })

    await expect(setup.service.create(context, {}, 'audit-failure')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    })
    await expect(setup.service.create(context, {}, 'audit-failure')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    })
    expect(setup.rateLimitChecks).toBe(0)
    expect(setup.session?.status).toBe('failed')
  })

  it.each([
    ['rate_limit', 'QUOTA_EXCEEDED', 429],
    ['redis', 'INTERNAL_DEPENDENCY_UNAVAILABLE', 503],
    ['target', 'POLICY_TARGET_FORBIDDEN', 403],
  ] as const)(
    'replays a normalized %s denial with the original status',
    async (failure, code, statusCode) => {
      const setup = fixture('success', { requestFailure: failure })
      const request = failure === 'target' ? { targetUrl: 'https://example.com' } : {}

      await expect(
        setup.service.create(context, request, `denial-${failure}`),
      ).rejects.toMatchObject({
        code,
        statusCode,
      })
      await expect(
        setup.service.create(context, request, `denial-${failure}`),
      ).rejects.toMatchObject({
        code,
        statusCode,
      })
      expect(setup.rateLimitChecks).toBe(1)
      expect(setup.targetPolicyChecks).toBe(failure === 'target' ? 1 : 0)
    },
  )

  it('performs one cross-runtime fallback after a transient allocation failure', async () => {
    const setup = fixture('transient_failure')
    const result = await setup.service.create(context, {}, 'create-2')
    expect(result.session).toMatchObject({
      status: 'active',
      runtime: { runtimeClass: 'chromium' },
      routing: { fallbackOccurred: true },
    })
    expect(setup.attempts).toHaveLength(2)
    expect(setup.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded'])
  })

  it('does not fallback when the request disables fallback', async () => {
    const setup = fixture('transient_failure')
    await expect(
      setup.service.create(
        context,
        {
          runtime: {
            preference: 'auto',
            allowFallback: false,
            allowExperimental: false,
          },
        },
        'create-3',
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ALLOCATION_FAILED' })
    expect(setup.attempts).toHaveLength(1)
  })

  it('does not fallback or leak details for provider authorization failure', async () => {
    const setup = fixture('authorization_error')
    await expect(setup.service.create(context, {}, 'create-4')).rejects.toMatchObject({
      code: 'PROVIDER_AUTHENTICATION_FAILED',
      message: 'The runtime provider could not authenticate the request.',
    })
    expect(setup.attempts).toHaveLength(1)

    await expect(setup.service.create(context, {}, 'create-4')).rejects.toMatchObject({
      code: 'PROVIDER_AUTHENTICATION_FAILED',
      statusCode: 502,
    })
    expect(setup.rateLimitChecks).toBe(1)
  })

  it('selects Chromium directly for required WebGL', async () => {
    const setup = fixture()
    const result = await setup.service.create(
      context,
      { capabilities: { webgl: 'required' } },
      'create-5',
    )
    expect(result.session.runtime?.runtimeClass).toBe('chromium')
    expect(setup.attempts).toHaveLength(1)
  })

  it('fails without provider allocation when no runtime is compatible', async () => {
    const setup = fixture()
    await expect(
      setup.service.create(context, { capabilities: { video: 'required' } }, 'create-6'),
    ).rejects.toMatchObject({ code: 'ROUTING_NO_COMPATIBLE_RUNTIME' })
    expect(setup.attempts).toHaveLength(0)
  })

  it('attempts bounded provider cleanup even when persistence and recovery reads fail', async () => {
    const setup = fixture('success', { failActivationAndRecoveryRead: true })
    const terminate = vi.spyOn(setup.kitesurf, 'terminate')

    await expect(
      setup.service.create(context, {}, 'cleanup-after-db-failure'),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(terminate.mock.calls[0]?.[1].signal).toBeUndefined()
  })
})
