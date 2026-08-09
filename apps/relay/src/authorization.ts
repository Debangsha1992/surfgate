import type { SessionID } from '@surfgate/contracts'
import { RelayTokenError, type RelayTokenClaims, type RelayTokenService } from '@surfgate/security'

import {
  RelayAuthorizationError,
  type RelayRevocationReader,
  type RelaySessionRecord,
  type RelaySessionRepository,
} from './relay-types.js'

export type AuthorizedRelaySession = RelaySessionRecord &
  Readonly<{ tokenClaims: RelayTokenClaims }>

export async function authorizeRelaySession(
  input: Readonly<{ token: string; pathSessionID: SessionID }>,
  dependencies: Readonly<{
    tokens: RelayTokenService
    sessions: RelaySessionRepository
    revocations: RelayRevocationReader
    now?: () => Date
  }>,
): Promise<AuthorizedRelaySession> {
  let claims: RelayTokenClaims
  try {
    claims = dependencies.tokens.verify(input.token)
  } catch (error: unknown) {
    if (error instanceof RelayTokenError && error.code === 'RELAY_TOKEN_EXPIRED') {
      throw new RelayAuthorizationError('TOKEN_EXPIRED')
    }
    throw new RelayAuthorizationError('AUTH_INVALID')
  }
  if (claims.sessionID !== input.pathSessionID) {
    throw new RelayAuthorizationError('AUTH_INVALID')
  }

  let session: RelaySessionRecord | null
  try {
    session = await dependencies.sessions.findSessionForTenant(claims.tenantID, claims.sessionID)
  } catch {
    throw new RelayAuthorizationError('INTERNAL_ERROR')
  }
  if (session === null) throw new RelayAuthorizationError('SESSION_NOT_FOUND')
  if (session.status !== 'active') {
    throw new RelayAuthorizationError('SESSION_NOT_CONNECTABLE')
  }
  const now = dependencies.now ?? (() => new Date())
  const expiresAtMs = session.expiresAt === null ? Number.NaN : Date.parse(session.expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now().getTime()) {
    throw new RelayAuthorizationError('SESSION_EXPIRED')
  }
  try {
    if (await dependencies.revocations.isSessionRevoked(claims.tenantID, claims.sessionID)) {
      throw new RelayAuthorizationError('SESSION_REVOKED')
    }
  } catch (error: unknown) {
    if (error instanceof RelayAuthorizationError) throw error
    throw new RelayAuthorizationError('INTERNAL_ERROR')
  }
  return Object.freeze({ ...session, tokenClaims: claims })
}
