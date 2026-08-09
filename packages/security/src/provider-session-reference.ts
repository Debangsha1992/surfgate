import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { ProviderSessionEncryptionConfig } from '@surfgate/config'
import { SessionIDSchema, TenantIDSchema, type SessionID, type TenantID } from '@surfgate/contracts'
import { ProviderSessionSchema, type ProviderSession } from '@surfgate/provider-core'
import { RoutingCandidateIdentitySchema, type RoutingCandidateIdentity } from '@surfgate/router'
import { z } from 'zod'

const ENVELOPE_PATTERN =
  /^psr\.v1\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/u
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export type ProviderSessionReferenceContext = Readonly<{
  tenantID: TenantID
  sessionID: SessionID
}>

export const ProtectedProviderSessionSchema = z
  .object({
    candidate: RoutingCandidateIdentitySchema,
    session: ProviderSessionSchema,
  })
  .strict()
  .readonly()
export type ProtectedProviderSession = z.infer<typeof ProtectedProviderSessionSchema>

export interface ProviderSessionReferenceProtector {
  encrypt(
    session: ProviderSession,
    candidate: RoutingCandidateIdentity,
    context: ProviderSessionReferenceContext,
  ): string
  decrypt(ciphertext: string, context: ProviderSessionReferenceContext): ProtectedProviderSession
}

function associatedData(context: ProviderSessionReferenceContext): Buffer {
  const tenantID = TenantIDSchema.parse(context.tenantID)
  const sessionID = SessionIDSchema.parse(context.sessionID)
  return Buffer.from(`${tenantID}\0${sessionID}`, 'utf8')
}

export function createProviderSessionReferenceProtector(
  config: ProviderSessionEncryptionConfig,
): ProviderSessionReferenceProtector {
  if (!KEY_ID_PATTERN.test(config.keyID)) {
    throw new Error('Provider session encryption key ID is invalid.')
  }
  return Object.freeze({
    encrypt(
      session: ProviderSession,
      candidate: RoutingCandidateIdentity,
      context: ProviderSessionReferenceContext,
    ): string {
      const validated = ProtectedProviderSessionSchema.parse({ session, candidate })
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', config.key, iv, { authTagLength: 16 })
      cipher.setAAD(associatedData(context))
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(validated), 'utf8'),
        cipher.final(),
      ])
      const tag = cipher.getAuthTag()
      return `psr.v1.${config.keyID}.${iv.toString('base64url')}.${encrypted.toString('base64url')}.${tag.toString('base64url')}`
    },
    decrypt(
      ciphertext: string,
      context: ProviderSessionReferenceContext,
    ): ProtectedProviderSession {
      try {
        const match = ENVELOPE_PATTERN.exec(ciphertext)
        if (
          match?.[1] !== config.keyID ||
          match[2] === undefined ||
          match[3] === undefined ||
          match[4] === undefined
        ) {
          throw new Error('Invalid envelope')
        }
        const decipher = createDecipheriv(
          'aes-256-gcm',
          config.key,
          Buffer.from(match[2], 'base64url'),
          { authTagLength: 16 },
        )
        decipher.setAAD(associatedData(context))
        decipher.setAuthTag(Buffer.from(match[4], 'base64url'))
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(match[3], 'base64url')),
          decipher.final(),
        ])
        return ProtectedProviderSessionSchema.parse(
          JSON.parse(plaintext.toString('utf8')) as unknown,
        )
      } catch {
        throw new Error('Provider session reference could not be decrypted.')
      }
    },
  })
}
