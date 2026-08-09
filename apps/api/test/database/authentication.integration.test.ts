import { afterEach, expect, it } from 'vitest'

import { APIKeyIDSchema, RequestIDSchema, TenantIDSchema } from '@surfgate/contracts'

import { issueAPIKey } from '../../src/auth/api-key.js'
import { createAPIKeyAuthenticator } from '../../src/auth/authentication.js'
import { TenantSchema } from '../../src/domain/tenant.js'
import { PostgresAPIKeyRepository } from '../../src/database/postgres-api-key-repository.js'
import { PostgresTenantRepository } from '../../src/database/postgres-tenant-repository.js'
import { database, describeWithDatabase } from './fixture.js'

const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FA0')
const API_KEY_ID = APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FA0')
const REQUEST_ID = RequestIDSchema.parse('req_01ARZ3NDEKTSV4RRFFQ69G5FA0')

describeWithDatabase('PostgreSQL API-key authentication', () => {
  afterEach(async () => {
    await database.query('delete from tenants where id = $1', [TENANT_ID])
  })

  it('persists no plaintext secret and authenticates through safe lookup metadata', async () => {
    const tenants = new PostgresTenantRepository(database)
    const apiKeys = new PostgresAPIKeyRepository(database)
    await tenants.insertTenant(
      TenantSchema.parse({
        id: TENANT_ID,
        name: 'Integration tenant',
        status: 'active',
        plan: 'development',
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
      }),
    )
    const issued = await issueAPIKey({
      id: API_KEY_ID,
      tenantID: TENANT_ID,
      mode: 'test',
      scopes: ['sessions:read'],
      now: new Date('2026-08-08T00:00:00.000Z'),
    })
    await apiKeys.insertAPIKey(issued.metadata)

    const stored = await database.query<Record<string, unknown>>(
      'select key_prefix, key_hash from api_keys where id = $1',
      [API_KEY_ID],
    )
    expect(JSON.stringify(stored)).not.toContain(issued.plaintext)
    await expect(
      createAPIKeyAuthenticator({ apiKeys, tenants })({
        authorization: `Bearer ${issued.plaintext}`,
        requestID: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ tenantID: TENANT_ID, apiKeyID: API_KEY_ID })
  })
})
