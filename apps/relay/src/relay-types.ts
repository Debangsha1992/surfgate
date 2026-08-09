import {
  PublicSessionStatusSchema,
  SessionIDSchema,
  TenantIDSchema,
  type SessionID,
  type TenantID,
} from '@surfgate/contracts'
import { z } from 'zod'

export const RelaySessionRecordSchema = z
  .object({
    tenantID: TenantIDSchema,
    sessionID: SessionIDSchema,
    status: PublicSessionStatusSchema,
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    providerSessionReferenceEncrypted: z.string().min(16).max(32_768).nullable(),
  })
  .strict()
  .readonly()
export type RelaySessionRecord = z.infer<typeof RelaySessionRecordSchema>

export interface RelaySessionRepository {
  findSessionForTenant(tenantID: TenantID, sessionID: SessionID): Promise<RelaySessionRecord | null>
}

export interface RelayRevocationReader {
  isSessionRevoked(tenantID: TenantID, sessionID: SessionID): Promise<boolean>
}

export const RELAY_FAILURE_CODES = [
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'TOKEN_EXPIRED',
  'SESSION_NOT_FOUND',
  'SESSION_NOT_CONNECTABLE',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'CONNECTION_CONFLICT',
  'UPSTREAM_CONNECT_FAILED',
  'UPSTREAM_CLOSED',
  'MESSAGE_TOO_LARGE',
  'BACKPRESSURE_LIMIT',
  'IDLE_TIMEOUT',
  'ABSOLUTE_TIMEOUT',
  'INTERNAL_ERROR',
] as const
export const RelayFailureCodeSchema = z.enum(RELAY_FAILURE_CODES)
export type RelayFailureCode = z.infer<typeof RelayFailureCodeSchema>

export class RelayAuthorizationError extends Error {
  readonly code: RelayFailureCode

  constructor(code: RelayFailureCode) {
    super('The relay connection is not authorized.')
    this.name = 'RelayAuthorizationError'
    this.code = code
  }
}
