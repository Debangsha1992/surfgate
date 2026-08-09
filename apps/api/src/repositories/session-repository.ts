import type { SessionID, TenantID } from '@surfgate/contracts'

import type { Session, SessionTransitionEvent } from '../domain/session.js'

export type TransitionSessionInput = Readonly<{
  tenantID: TenantID
  sessionID: SessionID
  expectedVersion: number
  event: SessionTransitionEvent
}>

export class SessionNotFoundError extends Error {
  readonly code = 'SESSION_NOT_FOUND' as const

  constructor() {
    super('The requested session was not found.')
    this.name = 'SessionNotFoundError'
  }
}

export class SessionTransitionConflictError extends Error {
  readonly code = 'SESSION_INVALID_TRANSITION' as const

  constructor() {
    super('The requested session transition is invalid.')
    this.name = 'SessionTransitionConflictError'
  }
}

export interface SessionRepository {
  insertSession(session: Session): Promise<Session>
  findSessionForTenant(tenantID: TenantID, sessionID: SessionID): Promise<Session | null>
  transitionSessionForTenant(input: TransitionSessionInput): Promise<Session>
}
