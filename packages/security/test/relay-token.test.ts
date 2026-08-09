import { createHmac, createSecretKey } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'

import { RelayTokenError, createRelayTokenService } from '../src/index.js'

const SIGNING = {
  key: createSecretKey(Buffer.alloc(32, 7)),
  keyID: 'relay-v1',
} as const
const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const NOW = new Date('2026-08-09T00:00:00.000Z')
const TOKEN_ID = `rtj_${'A'.repeat(22)}`

function signClaims(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const signingInput = `sgrt.v1.${SIGNING.keyID}.${payload}`
  const signature = createHmac('sha256', SIGNING.key).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}

function verifyFailure(operation: () => void): RelayTokenError {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof RelayTokenError) return error
    throw error
  }
  throw new Error('Expected relay token verification to fail.')
}

describe('relay token service', () => {
  it('issues and verifies a short-lived session-scoped credential', () => {
    const service = createRelayTokenService(SIGNING, {
      now: () => NOW,
      tokenID: () => TOKEN_ID,
    })
    const issued = service.issue({ tenantID: TENANT_ID, sessionID: SESSION_ID, ttlSeconds: 60 })

    expect(issued.expiresAt).toBe('2026-08-09T00:01:00.000Z')
    expect(service.verify(issued.token)).toMatchObject({
      audience: 'surfgate-relay',
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      tokenID: TOKEN_ID,
      issuedAt: 1_786_233_600,
      expiresAt: 1_786_233_660,
    })
    expect(issued.token).not.toContain(TENANT_ID)
    expect(issued.token).not.toContain(SESSION_ID)
  })

  it.each([
    ['', 'RELAY_TOKEN_MALFORMED'],
    ['sgrt.v1.relay-v1.invalid.invalid', 'RELAY_TOKEN_MALFORMED'],
  ] as const)('rejects malformed token input', (token, code) => {
    const service = createRelayTokenService(SIGNING, { now: () => NOW })
    expect(verifyFailure(() => service.verify(token)).code).toBe(code)
  })

  it('rejects an invalid signature without exposing token contents', () => {
    const service = createRelayTokenService(SIGNING, { now: () => NOW })
    const issued = service.issue({ tenantID: TENANT_ID, sessionID: SESSION_ID, ttlSeconds: 60 })
    const finalCharacter = issued.token.at(-1)
    const replacement = finalCharacter === 'A' ? 'E' : 'A'
    const tampered = `${issued.token.slice(0, -1)}${replacement}`

    try {
      service.verify(tampered)
      expect.fail('Expected signature verification to fail')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RelayTokenError)
      expect(error).toMatchObject({ code: 'RELAY_TOKEN_INVALID_SIGNATURE' })
      expect(error instanceof Error ? error.message : '').not.toContain(tampered)
    }
  })

  it('rejects a wrong audience even when correctly signed', () => {
    const service = createRelayTokenService(SIGNING, { now: () => NOW })
    const token = signClaims({
      version: 1,
      issuer: 'surfgate-control-plane',
      audience: 'another-service',
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      tokenID: TOKEN_ID,
      issuedAt: 1_786_233_600,
      expiresAt: 1_786_233_660,
    })

    expect(verifyFailure(() => service.verify(token)).code).toBe('RELAY_TOKEN_WRONG_AUDIENCE')
  })

  it('rejects an expired token', () => {
    const issuer = createRelayTokenService(SIGNING, { now: () => NOW })
    const issued = issuer.issue({ tenantID: TENANT_ID, sessionID: SESSION_ID, ttlSeconds: 10 })
    const verifier = createRelayTokenService(SIGNING, {
      now: () => new Date('2026-08-09T00:00:11.000Z'),
    })

    expect(verifyFailure(() => verifier.verify(issued.token)).code).toBe('RELAY_TOKEN_EXPIRED')
  })

  it('supports verification-key overlap during rotation', () => {
    const oldKey = { key: createSecretKey(Buffer.alloc(32, 2)), keyID: 'relay-old' } as const
    const oldIssuer = createRelayTokenService(oldKey, { now: () => NOW })
    const issued = oldIssuer.issue({ tenantID: TENANT_ID, sessionID: SESSION_ID, ttlSeconds: 60 })
    const rotated = createRelayTokenService(SIGNING, {
      now: () => NOW,
      verificationKeys: [oldKey],
    })

    expect(rotated.verify(issued.token).sessionID).toBe(SESSION_ID)
  })
})
