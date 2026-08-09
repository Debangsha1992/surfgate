import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

import { APIKeyIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { z } from 'zod'

const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const SCRYPT_KEY_LENGTH = 32
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024
const API_KEY_PATTERN = /^(sg_(live|test)_[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/u
const HASH_PATTERN = /^scrypt-v1\$(16384)\$(8)\$(1)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/u

export const API_KEY_SCOPES = [
  'sessions:read',
  'sessions:write',
  'sessions:terminate',
  'api-keys:manage',
] as const
export const APIKeyScopeSchema = z.enum(API_KEY_SCOPES)
export type APIKeyScope = z.infer<typeof APIKeyScopeSchema>

export const APIKeyMetadataSchema = z
  .object({
    id: APIKeyIDSchema,
    tenantID: TenantIDSchema,
    keyPrefix: z.string().regex(/^sg_(live|test)_[0-9a-f]{12}$/u),
    keyHash: z.string().regex(HASH_PATTERN),
    scopes: z.array(APIKeyScopeSchema).min(1).max(API_KEY_SCOPES.length).readonly(),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    revokedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (new Set(metadata.scopes).size !== metadata.scopes.length) {
      context.addIssue({ code: 'custom', message: 'API key scopes must be unique.' })
    }
    if (
      metadata.expiresAt !== undefined &&
      Date.parse(metadata.expiresAt) <= Date.parse(metadata.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'API key expiry must follow creation.',
        path: ['expiresAt'],
      })
    }
    if (
      metadata.revokedAt !== undefined &&
      Date.parse(metadata.revokedAt) < Date.parse(metadata.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'API key revocation cannot precede creation.',
        path: ['revokedAt'],
      })
    }
  })
  .readonly()
export type APIKeyMetadata = z.infer<typeof APIKeyMetadataSchema>

export type ParsedAPIKey = Readonly<{
  keyPrefix: string
  mode: 'live' | 'test'
  secret: string
}>

export type IssuedAPIKey = Readonly<{
  plaintext: string
  metadata: APIKeyMetadata
}>

function toBase64URL(value: Buffer): string {
  return value.toString('base64url')
}

async function deriveHash(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      secret,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error === null) {
          resolve(derivedKey)
        } else {
          reject(error)
        }
      },
    )
  })
}

export function parseAPIKey(plaintext: string): ParsedAPIKey {
  const match = API_KEY_PATTERN.exec(plaintext)
  const keyPrefix = match?.[1]
  const mode = match?.[2]
  const secret = match?.[3]
  if (keyPrefix === undefined || secret === undefined || (mode !== 'live' && mode !== 'test')) {
    throw new Error('Invalid API key format.')
  }
  return Object.freeze({ keyPrefix, mode, secret })
}

async function hashAPIKeySecret(secret: string): Promise<string> {
  const salt = randomBytes(16)
  const digest = await deriveHash(secret, salt)
  return `scrypt-v1$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${toBase64URL(salt)}$${toBase64URL(digest)}`
}

export async function issueAPIKey(
  input: Readonly<{
    id: z.input<typeof APIKeyIDSchema>
    tenantID: z.input<typeof TenantIDSchema>
    mode: 'live' | 'test'
    scopes: readonly APIKeyScope[]
    now: Date
    expiresAt?: Date
  }>,
): Promise<IssuedAPIKey> {
  const id = APIKeyIDSchema.parse(input.id)
  const tenantID = TenantIDSchema.parse(input.tenantID)
  const keyPrefix = `sg_${input.mode}_${randomBytes(6).toString('hex')}`
  const secret = toBase64URL(randomBytes(32))
  const plaintext = `${keyPrefix}_${secret}`
  const metadata = APIKeyMetadataSchema.parse({
    id,
    tenantID,
    keyPrefix,
    keyHash: await hashAPIKeySecret(secret),
    scopes: input.scopes,
    createdAt: input.now.toISOString(),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt.toISOString() }),
  })
  return Object.freeze({ plaintext, metadata })
}

export async function verifyAPIKeySecret(
  plaintext: string,
  metadata: APIKeyMetadata,
): Promise<boolean> {
  let parsed: ParsedAPIKey
  try {
    parsed = parseAPIKey(plaintext)
  } catch {
    return false
  }
  const validatedMetadata = APIKeyMetadataSchema.parse(metadata)
  const hashParts = HASH_PATTERN.exec(validatedMetadata.keyHash)
  const saltText = hashParts?.[4]
  const digestText = hashParts?.[5]
  if (saltText === undefined || digestText === undefined) {
    return false
  }
  const expected = Buffer.from(digestText, 'base64url')
  const actual = await deriveHash(parsed.secret, Buffer.from(saltText, 'base64url'))
  return (
    parsed.keyPrefix === validatedMetadata.keyPrefix &&
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
  )
}

export async function consumeDummyAPIKeyVerification(plaintext: string): Promise<void> {
  let secret = 'A'.repeat(43)
  try {
    secret = parseAPIKey(plaintext).secret
  } catch {
    // A fixed-length dummy keeps the expensive path independent of repository lookup success.
  }
  const actual = await deriveHash(secret, Buffer.alloc(16))
  timingSafeEqual(actual, Buffer.alloc(SCRYPT_KEY_LENGTH))
}
