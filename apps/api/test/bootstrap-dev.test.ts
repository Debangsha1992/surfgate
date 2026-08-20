import { describe, expect, it } from 'vitest'

import { verifyAPIKeySecret } from '../src/auth/api-key.js'
import { createDevelopmentAccess } from '../src/bootstrap-dev.js'

describe('development access bootstrap', () => {
  it('stores only hashed API-key metadata and returns the secret once', async () => {
    const tenants: unknown[] = []
    const apiKeys: unknown[] = []

    const result = await createDevelopmentAccess(
      {
        insertTenant: (tenant) => {
          tenants.push(tenant)
          return Promise.resolve(tenant)
        },
        insertAPIKey: (metadata) => {
          apiKeys.push(metadata)
          return Promise.resolve(metadata)
        },
      },
      new Date('2026-08-19T12:00:00.000Z'),
    )

    expect(result.apiKey).toMatch(/^sg_test_/u)
    expect(result.scopes).toContain('sessions:write')
    expect(tenants).toHaveLength(1)
    expect(apiKeys).toHaveLength(1)
    expect(JSON.stringify({ tenants, apiKeys })).not.toContain(result.apiKey)
    expect(await verifyAPIKeySecret(result.apiKey, result.apiKeyMetadata)).toBe(true)
  })
})
