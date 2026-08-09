import { describe, expect, it, vi } from 'vitest'

import { APIKeyIDSchema, RequestIDSchema, TenantIDSchema } from '@surfgate/contracts'

import { issueAPIKey } from '../../src/auth/api-key.js'
import { AuthenticationError, createAPIKeyAuthenticator } from '../../src/auth/authentication.js'
import type { APIKeyRepository } from '../../src/repositories/api-key-repository.js'
import type { TenantRepository } from '../../src/repositories/tenant-repository.js'

const API_KEY_ID = APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const REQUEST_ID = RequestIDSchema.parse('req_01ARZ3NDEKTSV4RRFFQ69G5FAV')

async function fixture(
  options: { revoked?: boolean; expired?: boolean; tenantStatus?: 'active' | 'suspended' } = {},
) {
  const issued = await issueAPIKey({
    id: API_KEY_ID,
    tenantID: TENANT_ID,
    mode: 'live',
    scopes: ['sessions:read'],
    now: new Date('2026-08-08T00:00:00.000Z'),
    ...(options.expired ? { expiresAt: new Date('2026-08-08T00:00:01.000Z') } : {}),
  })
  const record = {
    ...issued.metadata,
    ...(options.revoked ? { revokedAt: '2026-08-08T00:00:02.000Z' } : {}),
  }
  const apiKeys: APIKeyRepository = {
    findAPIKeyByPrefix: vi.fn(() => Promise.resolve(record)),
    insertAPIKey: vi.fn(() => Promise.resolve(record)),
  }
  const tenants: TenantRepository = {
    findTenantByID: vi.fn(() =>
      Promise.resolve({
        id: TENANT_ID,
        name: 'Example tenant',
        status: options.tenantStatus ?? 'active',
        plan: 'development',
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
      }),
    ),
    insertTenant: vi.fn(),
  }
  return { issued, authenticate: createAPIKeyAuthenticator({ apiKeys, tenants }) }
}

describe('API-key authentication', () => {
  it('establishes tenant context for a valid bearer credential', async () => {
    const { issued, authenticate } = await fixture()

    await expect(
      authenticate({ authorization: `Bearer ${issued.plaintext}`, requestID: REQUEST_ID }),
    ).resolves.toEqual({
      tenantID: TENANT_ID,
      apiKeyID: API_KEY_ID,
      scopes: ['sessions:read'],
      requestID: REQUEST_ID,
    })
  })

  it.each([
    ['missing', undefined],
    ['malformed', 'Basic credentials'],
    ['wrong secret', 'Bearer sg_live_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ] as const)('normalizes %s credentials', async (_name, authorization) => {
    const { authenticate } = await fixture()
    await expect(authenticate({ authorization, requestID: REQUEST_ID })).rejects.toMatchObject({
      code: authorization === undefined ? 'AUTH_UNAUTHORIZED' : 'AUTH_INVALID_CREDENTIALS',
    })
  })

  it.each([
    ['revoked', { revoked: true }],
    ['expired', { expired: true }],
    ['inactive tenant', { tenantStatus: 'suspended' as const }],
  ])('rejects a %s credential without exposing why publicly', async (_name, options) => {
    const { issued, authenticate } = await fixture(options)
    const action = authenticate({
      authorization: `Bearer ${issued.plaintext}`,
      requestID: REQUEST_ID,
      now: new Date('2026-08-08T00:00:03.000Z'),
    })

    await expect(action).rejects.toBeInstanceOf(AuthenticationError)
    await expect(action).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
  })

  it('rejects a missing scope with a stable forbidden code', async () => {
    const { issued, authenticate } = await fixture()
    await expect(
      authenticate({
        authorization: `Bearer ${issued.plaintext}`,
        requestID: REQUEST_ID,
        requiredScopes: ['sessions:write'],
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' })
  })
})
