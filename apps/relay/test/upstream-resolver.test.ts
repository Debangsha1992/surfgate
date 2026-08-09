import { describe, expect, it } from 'vitest'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { ProviderSessionSchema } from '@surfgate/provider-core'
import { ProtectedProviderSessionSchema } from '@surfgate/security'

import { createUpstreamConnectionResolver, type RelaySessionRecord } from '../src/index.js'

const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const PROVIDER_SESSION_ID = '123e4567-e89b-12d3-a456-426614174000'
const providerSession = ProviderSessionSchema.parse({
  reference: {
    providerID: 'cloudflare-browser-run',
    runtimeClass: 'chromium',
    providerSessionID: PROVIDER_SESSION_ID,
  },
  connection: {
    transport: 'websocket',
    endpoint: `wss://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/browser-rendering/devtools/browser/${PROVIDER_SESSION_ID}`,
    credentialReference: `cloudflare-browser-run:${PROVIDER_SESSION_ID}`,
  },
  allocatedAt: '2026-08-09T00:00:00.000Z',
  expiresAt: '2026-08-09T00:10:00.000Z',
  metadata: { configProfile: 'browser-run-chromium' },
})
const record: RelaySessionRecord = {
  tenantID: TENANT_ID,
  sessionID: SESSION_ID,
  status: 'active',
  expiresAt: providerSession.expiresAt,
  providerSessionReferenceEncrypted: 'encrypted-reference',
}

describe('upstream connection resolver', () => {
  it('decrypts tenant-bound metadata and resolves provider credentials internally', () => {
    const resolver = createUpstreamConnectionResolver({
      protector: {
        encrypt: () => 'unused',
        decrypt: (_ciphertext, context) => {
          expect(context).toEqual({ tenantID: TENANT_ID, sessionID: SESSION_ID })
          return ProtectedProviderSessionSchema.parse({
            candidate: {
              candidateID: 'cloudflare-browser-run::chromium::-::=browser-run-chromium',
              providerID: 'cloudflare-browser-run',
              runtimeClass: 'chromium',
              configProfile: 'browser-run-chromium',
            },
            session: providerSession,
          })
        },
      },
      resolveProviderConnection: (session) => ({
        endpoint: session.connection.endpoint,
        headers: { Authorization: 'Bearer provider-secret' },
      }),
    })

    const resolved = resolver.resolve(record)
    expect(resolved.headers.Authorization).toBe('Bearer provider-secret')
    expect(JSON.stringify(record)).not.toContain('provider-secret')
  })

  it('accepts equivalent provider expiry instants with different offsets', () => {
    const resolver = createUpstreamConnectionResolver({
      protector: {
        encrypt: () => 'unused',
        decrypt: () =>
          ProtectedProviderSessionSchema.parse({
            candidate: {
              candidateID: 'cloudflare-browser-run::chromium::-::=browser-run-chromium',
              providerID: 'cloudflare-browser-run',
              runtimeClass: 'chromium',
              configProfile: 'browser-run-chromium',
            },
            session: {
              ...providerSession,
              expiresAt: '2026-08-09T05:40:00.000+05:30',
            },
          }),
      },
      resolveProviderConnection: (session) => ({
        endpoint: session.connection.endpoint,
        headers: {},
      }),
    })

    expect(() => resolver.resolve(record)).not.toThrow()
  })

  it('returns only sanitized failures for missing or invalid protected references', () => {
    const resolver = createUpstreamConnectionResolver({
      protector: {
        encrypt: () => 'unused',
        decrypt: () => {
          throw new Error('provider-secret wss://secret.example')
        },
      },
      resolveProviderConnection: () => {
        throw new Error('not reached')
      },
    })
    try {
      resolver.resolve(record)
      expect.fail('Expected resolver to reject invalid protected state')
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'UPSTREAM_CONNECT_FAILED' })
      expect(error instanceof Error ? error.message : '').not.toContain('provider-secret')
      expect(error instanceof Error ? error.message : '').not.toContain('secret.example')
    }
  })
})
