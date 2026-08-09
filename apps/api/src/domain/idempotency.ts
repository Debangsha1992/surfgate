import type { SessionID, TenantID } from '@surfgate/contracts'

import type { Session } from './session.js'

export type SessionCreateClaim =
  | Readonly<{ kind: 'owner'; session: Session }>
  | Readonly<{
      kind: 'existing'
      session: Session
      state: 'in_progress' | 'succeeded' | 'failed'
      httpStatus: number | null
      errorCode: string | null
    }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'quota_exceeded' }>

export type ClaimSessionCreateInput = Readonly<{
  tenantID: TenantID
  key: string
  requestHash: string
  ownerToken: string
  leaseExpiresAt: string
  session: Session
  maxConcurrentSessions: number
}>

export interface SessionCreateCoordinator {
  claim(input: ClaimSessionCreateInput): Promise<SessionCreateClaim>
  complete(
    input: Readonly<{
      tenantID: TenantID
      key: string
      ownerToken: string
      sessionID: SessionID
      state: 'succeeded' | 'failed'
      httpStatus: number
      errorCode?: string
      at: string
    }>,
  ): Promise<void>
  waitForCompletion(
    input: Readonly<{
      tenantID: TenantID
      key: string
      requestHash: string
      timeoutMs: number
    }>,
  ): Promise<SessionCreateClaim>
}
