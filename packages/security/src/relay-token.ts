import { createHmac, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto'

import {
  RelayTokenSchema,
  SessionIDSchema,
  TenantIDSchema,
  type RelayToken,
  type SessionID,
  type TenantID,
} from '@surfgate/contracts'
import { z } from 'zod'

const TOKEN_PATTERN =
  /^sgrt\.v1\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u
const MAX_TOKEN_TTL_SECONDS = 300
const CLOCK_SKEW_SECONDS = 5

export const RelayTokenIDSchema = z.string().regex(/^rtj_[A-Za-z0-9_-]{22}$/u)
export type RelayTokenID = z.infer<typeof RelayTokenIDSchema>

export const RelayTokenClaimsSchema = z
  .object({
    version: z.literal(1),
    issuer: z.literal('surfgate-control-plane'),
    audience: z.literal('surfgate-relay'),
    tenantID: TenantIDSchema,
    sessionID: SessionIDSchema,
    tokenID: RelayTokenIDSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .superRefine((claims, context) => {
    const ttl = claims.expiresAt - claims.issuedAt
    if (ttl < 1 || ttl > MAX_TOKEN_TTL_SECONDS) {
      context.addIssue({ code: 'custom', message: 'Relay token lifetime is invalid.' })
    }
  })
  .readonly()
export type RelayTokenClaims = z.infer<typeof RelayTokenClaimsSchema>

export const RELAY_TOKEN_ERROR_CODES = [
  'RELAY_TOKEN_MALFORMED',
  'RELAY_TOKEN_INVALID_SIGNATURE',
  'RELAY_TOKEN_WRONG_AUDIENCE',
  'RELAY_TOKEN_EXPIRED',
] as const
export type RelayTokenErrorCode = (typeof RELAY_TOKEN_ERROR_CODES)[number]

export class RelayTokenError extends Error {
  readonly code: RelayTokenErrorCode

  constructor(code: RelayTokenErrorCode) {
    super('The relay token is invalid.')
    this.name = 'RelayTokenError'
    this.code = code
  }
}

export type RelaySigningKey = Readonly<{ key: KeyObject; keyID: string }>
export type IssuedRelayToken = Readonly<{ token: RelayToken; expiresAt: string }>

export interface RelayTokenService {
  issue(
    input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ttlSeconds: number }>,
  ): IssuedRelayToken
  verify(token: string): RelayTokenClaims
}

function tokenID(): RelayTokenID {
  return RelayTokenIDSchema.parse(`rtj_${randomBytes(16).toString('base64url')}`)
}

function signature(key: KeyObject, signingInput: string): Buffer {
  return createHmac('sha256', key).update(signingInput).digest()
}

function keyMap(
  primary: RelaySigningKey,
  additional: readonly RelaySigningKey[],
): ReadonlyMap<string, KeyObject> {
  const entries = [primary, ...additional].map((item) => [item.keyID, item.key] as const)
  if (new Set(entries.map(([keyID]) => keyID)).size !== entries.length) {
    throw new Error('Relay token key identifiers must be unique.')
  }
  return new Map(entries)
}

export function createRelayTokenService(
  signingKey: RelaySigningKey,
  options: Readonly<{
    now?: () => Date
    tokenID?: () => string
    verificationKeys?: readonly RelaySigningKey[]
  }> = {},
): RelayTokenService {
  const now = options.now ?? (() => new Date())
  const createTokenID = options.tokenID ?? tokenID
  const verificationKeys = keyMap(signingKey, options.verificationKeys ?? [])

  return Object.freeze({
    issue(
      input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ttlSeconds: number }>,
    ): IssuedRelayToken {
      const issuedAt = Math.floor(now().getTime() / 1_000)
      const claims = RelayTokenClaimsSchema.parse({
        version: 1,
        issuer: 'surfgate-control-plane',
        audience: 'surfgate-relay',
        tenantID: input.tenantID,
        sessionID: input.sessionID,
        tokenID: RelayTokenIDSchema.parse(createTokenID()),
        issuedAt,
        expiresAt: issuedAt + input.ttlSeconds,
      })
      const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
      const signingInput = `sgrt.v1.${signingKey.keyID}.${payload}`
      const token = RelayTokenSchema.parse(
        `${signingInput}.${signature(signingKey.key, signingInput).toString('base64url')}`,
      )
      return Object.freeze({
        token,
        expiresAt: new Date(claims.expiresAt * 1_000).toISOString(),
      })
    },

    verify(rawToken: string): RelayTokenClaims {
      const match = TOKEN_PATTERN.exec(rawToken)
      const keyID = match?.[1]
      const payload = match?.[2]
      const encodedSignature = match?.[3]
      if (keyID === undefined || payload === undefined || encodedSignature === undefined) {
        throw new RelayTokenError('RELAY_TOKEN_MALFORMED')
      }
      const key = verificationKeys.get(keyID)
      if (key === undefined) {
        throw new RelayTokenError('RELAY_TOKEN_INVALID_SIGNATURE')
      }
      const signingInput = `sgrt.v1.${keyID}.${payload}`
      const expected = signature(key, signingInput)
      const actual = Buffer.from(encodedSignature, 'base64url')
      if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
        throw new RelayTokenError('RELAY_TOKEN_INVALID_SIGNATURE')
      }

      let untrustedClaims: unknown
      try {
        untrustedClaims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
      } catch {
        throw new RelayTokenError('RELAY_TOKEN_MALFORMED')
      }
      const parsed = RelayTokenClaimsSchema.safeParse(untrustedClaims)
      if (!parsed.success) {
        const audience =
          untrustedClaims !== null &&
          typeof untrustedClaims === 'object' &&
          'audience' in untrustedClaims
            ? untrustedClaims.audience
            : undefined
        throw new RelayTokenError(
          audience !== undefined && audience !== 'surfgate-relay'
            ? 'RELAY_TOKEN_WRONG_AUDIENCE'
            : 'RELAY_TOKEN_MALFORMED',
        )
      }
      const currentEpochSeconds = Math.floor(now().getTime() / 1_000)
      if (parsed.data.issuedAt > currentEpochSeconds + CLOCK_SKEW_SECONDS) {
        throw new RelayTokenError('RELAY_TOKEN_MALFORMED')
      }
      if (parsed.data.expiresAt <= currentEpochSeconds) {
        throw new RelayTokenError('RELAY_TOKEN_EXPIRED')
      }
      return parsed.data
    },
  })
}
