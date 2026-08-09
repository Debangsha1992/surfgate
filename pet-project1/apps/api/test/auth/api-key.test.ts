import { describe, expect, it } from 'vitest'

import { APIKeyIDSchema, TenantIDSchema } from '@surfgate/contracts'

import { issueAPIKey, parseAPIKey, verifyAPIKeySecret } from '../../src/auth/api-key.js'

const API_KEY_ID = APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')

describe('API-key secrets', () => {
  it('issues a one-time high-entropy key while storing only prefix and hash metadata', async () => {
    const issued = await issueAPIKey({
      id: API_KEY_ID,
      tenantID: TENANT_ID,
      mode: 'live',
      scopes: ['sessions:read'],
      now: new Date('2026-08-08T00:00:00.000Z'),
    })

    expect(issued.plaintext).toMatch(/^sg_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/u)
    expect(issued.metadata.keyPrefix).toMatch(/^sg_live_[0-9a-f]{12}$/u)
    expect(issued.metadata.keyHash).toMatch(/^scrypt-v1\$/u)
    expect(issued.metadata.keyHash).not.toContain(issued.plaintext)
    expect(JSON.stringify(issued.metadata)).not.toContain(parseAPIKey(issued.plaintext).secret)
    expect(await verifyAPIKeySecret(issued.plaintext, issued.metadata)).toBe(true)
  })

  it('rejects malformed and incorrect API keys', async () => {
    const issued = await issueAPIKey({
      id: API_KEY_ID,
      tenantID: TENANT_ID,
      mode: 'test',
      scopes: ['sessions:write'],
      now: new Date('2026-08-08T00:00:00.000Z'),
    })

    expect(() => parseAPIKey('sg_live_short')).toThrowError('Invalid API key format.')
    expect(
      await verifyAPIKeySecret(
        `${issued.plaintext.slice(0, -1)}${issued.plaintext.endsWith('A') ? 'B' : 'A'}`,
        issued.metadata,
      ),
    ).toBe(false)
  })
})
