import { createSecretKey } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { ProviderSessionSchema } from '@surfgate/provider-core'
import {
  RoutingCandidateIdentitySchema,
  createRoutingCandidateIDFromIdentity,
} from '@surfgate/router'

import { createProviderSessionReferenceProtector } from '../../src/security/provider-session-reference.js'

const CONTEXT = {
  tenantID: TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  sessionID: SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
}
const PROVIDER_SESSION = ProviderSessionSchema.parse({
  reference: {
    providerID: 'cloudflare-browser-run',
    runtimeClass: 'chromium',
    providerSessionID: 'upstream-session-1',
  },
  connection: {
    transport: 'websocket',
    endpoint: 'wss://api.cloudflare.com/session/upstream-session-1',
    credentialReference: 'cloudflare-browser-run-token',
  },
  allocatedAt: '2026-08-08T00:00:00.000Z',
  expiresAt: '2026-08-08T00:05:00.000Z',
  metadata: { configProfile: 'browser-run-chromium' },
})
const CANDIDATE = RoutingCandidateIdentitySchema.parse({
  candidateID: createRoutingCandidateIDFromIdentity({
    providerID: 'cloudflare-browser-run',
    runtimeClass: 'chromium',
    configProfile: 'browser-run-chromium',
  }),
  providerID: 'cloudflare-browser-run',
  runtimeClass: 'chromium',
  configProfile: 'browser-run-chromium',
})

describe('provider session reference protection', () => {
  it('rejects key IDs that cannot be represented in an encrypted envelope', () => {
    expect(() =>
      createProviderSessionReferenceProtector({
        key: createSecretKey(Buffer.alloc(32, 7)),
        keyID: 'invalid key id',
      }),
    ).toThrowError('Provider session encryption key ID is invalid.')
  })

  it('round-trips a validated provider session using randomized authenticated encryption', () => {
    const protector = createProviderSessionReferenceProtector({
      key: createSecretKey(Buffer.alloc(32, 3)),
      keyID: 'test-v1',
    })
    const first = protector.encrypt(PROVIDER_SESSION, CANDIDATE, CONTEXT)
    const second = protector.encrypt(PROVIDER_SESSION, CANDIDATE, CONTEXT)

    expect(first).not.toBe(second)
    expect(first).not.toContain(PROVIDER_SESSION.connection.endpoint)
    expect(protector.decrypt(first, CONTEXT)).toEqual({
      candidate: CANDIDATE,
      session: PROVIDER_SESSION,
    })
  })

  it('fails closed for a different tenant/session context without leaking plaintext', () => {
    const protector = createProviderSessionReferenceProtector({
      key: createSecretKey(Buffer.alloc(32, 4)),
      keyID: 'test-v1',
    })
    const ciphertext = protector.encrypt(PROVIDER_SESSION, CANDIDATE, CONTEXT)

    expect(() =>
      protector.decrypt(ciphertext, {
        ...CONTEXT,
        tenantID: TenantIDSchema.parse('ten_01BX5ZZKBKACTAV9WEVGEMMVS0'),
      }),
    ).toThrowError('Provider session reference could not be decrypted.')
  })

  it('decrypts an old envelope during a bounded key-rotation overlap', () => {
    const oldKey = { key: createSecretKey(Buffer.alloc(32, 2)), keyID: 'provider-old' } as const
    const ciphertext = createProviderSessionReferenceProtector(oldKey).encrypt(
      PROVIDER_SESSION,
      CANDIDATE,
      CONTEXT,
    )
    const rotated = createProviderSessionReferenceProtector({
      key: createSecretKey(Buffer.alloc(32, 3)),
      keyID: 'provider-current',
      decryptionKeys: [oldKey],
    })

    expect(rotated.decrypt(ciphertext, CONTEXT)).toEqual({
      candidate: CANDIDATE,
      session: PROVIDER_SESSION,
    })
    expect(rotated.encrypt(PROVIDER_SESSION, CANDIDATE, CONTEXT)).toContain('.provider-current.')
  })
})
