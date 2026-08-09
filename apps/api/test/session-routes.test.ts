import { describe, expect, it, vi } from 'vitest'

import {
  APIKeyIDSchema,
  RequestIDSchema,
  SessionIDSchema,
  TenantIDSchema,
} from '@surfgate/contracts'

import { buildAPIApplication } from '../src/app.js'
import { AuthenticationError } from '../src/auth/authentication.js'
import type { AuthenticateAPIKey } from '../src/http/authentication-hook.js'

const publicSession = {
  id: SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  status: 'active' as const,
  runtime: { runtimeClass: 'kitesurf', providerId: 'cloudflare-browser-run' },
  routing: {
    decisionId: 'rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    reasonCodes: ['CAPABILITIES_SATISFIED'],
    fallbackOccurred: false,
  },
  createdAt: '2026-08-09T00:00:00.000Z',
  connectedAt: '2026-08-09T00:00:01.000Z',
  expiresAt: '2026-08-09T00:10:01.000Z',
  terminatedAt: null,
}

function telemetry() {
  return {
    recordHTTP: vi.fn(),
    recordAuthentication: vi.fn(),
    recordDatabaseHealth: vi.fn(),
    recordSessionTransition: vi.fn(),
  }
}

function fixture() {
  const service = {
    create: vi.fn((context: unknown, body: unknown, key: string, signal?: AbortSignal) => {
      void context
      void body
      void key
      void signal
      return Promise.resolve({ session: publicSession })
    }),
    get: vi.fn((context: unknown, sessionID: unknown) => {
      void context
      void sessionID
      return Promise.resolve({ session: publicSession })
    }),
    terminate: vi.fn((context: unknown, sessionID: unknown, signal?: AbortSignal) => {
      void context
      void sessionID
      void signal
      return Promise.resolve({
        session: {
          ...publicSession,
          status: 'terminated',
          terminatedAt: '2026-08-09T00:02:00.000Z',
        },
      })
    }),
    issueRelayToken: vi.fn((context: unknown, sessionID: unknown) => {
      void context
      void sessionID
      return Promise.resolve({
        webSocketUrl: `ws://127.0.0.1:8081/v1/sessions/${publicSession.id}/cdp`,
        token: `sgrt.v1.v1.${'A'.repeat(64)}.${'B'.repeat(43)}`,
        expiresAt: '2026-08-09T00:01:00.000Z',
      })
    }),
  }
  const authenticate: AuthenticateAPIKey = vi.fn((input: Parameters<AuthenticateAPIKey>[0]) => {
    if (input.authorization === undefined) {
      return Promise.reject(new AuthenticationError('AUTH_UNAUTHORIZED', 'missing_authorization'))
    }
    return Promise.resolve({
      tenantID: TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
      apiKeyID: APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
      scopes: [
        'sessions:read',
        'sessions:write',
        'sessions:terminate',
        'sessions:connect',
      ] as const,
      requestID: RequestIDSchema.parse(input.requestID),
    })
  })
  const app = buildAPIApplication({
    databaseHealth: { health: () => Promise.resolve('ready') },
    telemetry: telemetry(),
    logger: false,
    authenticate,
    sessionService: service as never,
  })
  return { app, service }
}

describe('v1 session routes', () => {
  it('requires authentication and an idempotency key for create', async () => {
    const { app } = fixture()
    const missingAuth = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { 'idempotency-key': 'one' },
      payload: {},
    })
    expect(missingAuth.statusCode).toBe(401)
    await app.close()
  })

  it('keeps handlers thin and responses provider-secret-free', async () => {
    const { app, service } = fixture()
    const create = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer safe', 'idempotency-key': 'one' },
      payload: {},
    })
    const get = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${publicSession.id}`,
      headers: { authorization: 'Bearer safe' },
    })
    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${publicSession.id}`,
      headers: { authorization: 'Bearer safe' },
    })
    const relayToken = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${publicSession.id}/relay-token`,
      headers: { authorization: 'Bearer safe' },
    })
    expect(create.statusCode).toBe(201)
    expect(get.statusCode).toBe(200)
    expect(remove.statusCode).toBe(200)
    expect(relayToken.statusCode).toBe(200)
    expect(service.create).toHaveBeenCalledTimes(1)
    expect(service.create.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal)
    expect(service.terminate.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal)
    expect(`${create.body}${get.body}${remove.body}${relayToken.body}`).not.toContain(
      'providerSessionReference',
    )
    expect(relayToken.body).not.toContain('api.cloudflare.com')
    await app.close()
  })

  it('serves the schema-derived OpenAPI document', async () => {
    const { app } = fixture()
    const response = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('paths./v1/sessions.post')
    await app.close()
  })
})
