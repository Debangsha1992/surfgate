import { describe, expect, it, vi } from 'vitest'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { createSecretKey } from 'node:crypto'
import { createRelayTokenService } from '@surfgate/security'

import {
  RelayAuthorizationError,
  authorizeRelaySession,
  type RelaySessionRecord,
} from '../src/index.js'

const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const OTHER_TENANT_ID = TenantIDSchema.parse('ten_01BX5ZZKBKACTAV9WEVGEMMVRY')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const OTHER_SESSION_ID = SessionIDSchema.parse('ses_01BX5ZZKBKACTAV9WEVGEMMVRY')
const NOW = new Date('2026-08-09T00:00:00.000Z')
const tokens = createRelayTokenService(
  { key: createSecretKey(Buffer.alloc(32, 7)), keyID: 'relay-v1' },
  { now: () => NOW, tokenID: () => `rtj_${'A'.repeat(22)}` },
)

function record(status: RelaySessionRecord['status'], overrides: Partial<RelaySessionRecord> = {}) {
  return {
    tenantID: TENANT_ID,
    sessionID: SESSION_ID,
    status,
    expiresAt: '2026-08-09T00:10:00.000Z',
    providerSessionReferenceEncrypted: 'psr.v1.placeholder',
    ...overrides,
  } satisfies RelaySessionRecord
}

function token(tenantID = TENANT_ID, sessionID = SESSION_ID): string {
  return tokens.issue({ tenantID, sessionID, ttlSeconds: 60 }).token
}

describe('relay authorization', () => {
  it('authorizes an active, unexpired, unrevoked tenant session', async () => {
    const find = vi.fn(() => Promise.resolve(record('active')))
    await expect(
      authorizeRelaySession(
        { token: token(), pathSessionID: SESSION_ID },
        {
          tokens,
          sessions: { findSessionForTenant: find },
          revocations: { isSessionRevoked: () => Promise.resolve(false) },
          now: () => NOW,
        },
      ),
    ).resolves.toMatchObject({ tenantID: TENANT_ID, sessionID: SESSION_ID, status: 'active' })
    expect(find).toHaveBeenCalledWith(TENANT_ID, SESSION_ID)
  })

  it.each([
    'pending',
    'routing',
    'allocating',
    'fallback_allocating',
    'terminating',
    'terminated',
    'expired',
    'failed',
  ] as const)('rejects non-connectable %s sessions', async (status) => {
    await expect(
      authorizeRelaySession(
        { token: token(), pathSessionID: SESSION_ID },
        {
          tokens,
          sessions: { findSessionForTenant: () => Promise.resolve(record(status)) },
          revocations: { isSessionRevoked: () => Promise.resolve(false) },
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_CONNECTABLE' })
  })

  it('rejects path mismatch before session lookup', async () => {
    const find = vi.fn(() => Promise.resolve(record('active')))
    await expect(
      authorizeRelaySession(
        { token: token(), pathSessionID: OTHER_SESSION_ID },
        {
          tokens,
          sessions: { findSessionForTenant: find },
          revocations: { isSessionRevoked: () => Promise.resolve(false) },
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' })
    expect(find).not.toHaveBeenCalled()
  })

  it('does not reveal cross-tenant session existence', async () => {
    await expect(
      authorizeRelaySession(
        { token: token(OTHER_TENANT_ID), pathSessionID: SESSION_ID },
        {
          tokens,
          sessions: {
            findSessionForTenant: (tenantID) =>
              Promise.resolve(tenantID === TENANT_ID ? record('active') : null),
          },
          revocations: { isSessionRevoked: () => Promise.resolve(false) },
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
  })

  it('rejects expired and revoked sessions', async () => {
    await expect(
      authorizeRelaySession(
        { token: token(), pathSessionID: SESSION_ID },
        {
          tokens,
          sessions: {
            findSessionForTenant: () =>
              Promise.resolve(record('active', { expiresAt: '2026-08-08T23:59:59.000Z' })),
          },
          revocations: { isSessionRevoked: () => Promise.resolve(false) },
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })

    await expect(
      authorizeRelaySession(
        { token: token(), pathSessionID: SESSION_ID },
        {
          tokens,
          sessions: { findSessionForTenant: () => Promise.resolve(record('active')) },
          revocations: { isSessionRevoked: () => Promise.resolve(true) },
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
  })

  it('fails closed when revocation consistency is unavailable', async () => {
    await expect(
      authorizeRelaySession(
        { token: token(), pathSessionID: SESSION_ID },
        {
          tokens,
          sessions: { findSessionForTenant: () => Promise.resolve(record('active')) },
          revocations: { isSessionRevoked: () => Promise.reject(new Error('redis unavailable')) },
          now: () => NOW,
        },
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('normalizes malformed, invalid-signature, and expired credentials', async () => {
    const dependencies = {
      tokens,
      sessions: { findSessionForTenant: () => Promise.resolve(record('active')) },
      revocations: { isSessionRevoked: () => Promise.resolve(false) },
      now: () => NOW,
    }
    await expect(
      authorizeRelaySession({ token: 'bad', pathSessionID: SESSION_ID }, dependencies),
    ).rejects.toBeInstanceOf(RelayAuthorizationError)
    await expect(
      authorizeRelaySession(
        { token: `${token().slice(0, -1)}Z`, pathSessionID: SESSION_ID },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' })
  })
})
