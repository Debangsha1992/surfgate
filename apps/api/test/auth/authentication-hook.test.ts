import { describe, expect, it, vi } from 'vitest'

import { APIKeyIDSchema, TenantIDSchema } from '@surfgate/contracts'

import { buildAPIApplication } from '../../src/app.js'
import { AuthenticationError } from '../../src/auth/authentication.js'
import type { AuthenticatedTenantContext } from '../../src/auth/context.js'
import { createAuthenticationHook } from '../../src/http/authentication-hook.js'

const CONTEXT: Omit<AuthenticatedTenantContext, 'requestID'> = {
  tenantID: TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  apiKeyID: APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  scopes: ['sessions:read'],
}

function telemetry() {
  return {
    recordHTTP: vi.fn(),
    recordAuthentication: vi.fn(),
    recordDatabaseHealth: vi.fn(),
    recordSessionTransition: vi.fn(),
  }
}

describe('Fastify authentication hook', () => {
  it('rejects missing credentials and establishes tenant context for valid credentials', async () => {
    const metrics = telemetry()
    const authenticate = vi.fn(
      (input: {
        authorization: string | undefined
        requestID: AuthenticatedTenantContext['requestID']
      }) => {
        if (input.authorization === undefined) {
          return Promise.reject(
            new AuthenticationError('AUTH_UNAUTHORIZED', 'missing_authorization'),
          )
        }
        return Promise.resolve({ ...CONTEXT, requestID: input.requestID })
      },
    )
    const app = buildAPIApplication({
      databaseHealth: { health: vi.fn(() => Promise.resolve('ready' as const)) },
      telemetry: metrics,
      logger: false,
    })
    app.get(
      '/_test/protected',
      { preHandler: createAuthenticationHook({ authenticate, telemetry: metrics }) },
      (request) => ({ tenantID: request.auth.tenantID }),
    )

    const missing = await app.inject({ method: 'GET', url: '/_test/protected' })
    const valid = await app.inject({
      method: 'GET',
      url: '/_test/protected',
      headers: { authorization: 'Bearer sg_live_test' },
    })

    expect(missing.statusCode).toBe(401)
    expect(missing.json()).toMatchObject({ error: { code: 'AUTH_UNAUTHORIZED' } })
    expect(valid.statusCode).toBe(200)
    expect(valid.json()).toEqual({ tenantID: CONTEXT.tenantID })
    expect(metrics.recordAuthentication).toHaveBeenCalledWith({
      outcome: 'success',
      reason: 'authenticated',
    })
    await app.close()
  })
})
