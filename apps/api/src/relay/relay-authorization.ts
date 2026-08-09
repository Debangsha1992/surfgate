import type { SessionID, TenantID } from '@surfgate/contracts'

export interface RelayAuthorizationStore {
  isSessionRevoked(tenantID: TenantID, sessionID: SessionID): Promise<boolean>
  revokeSession(
    input: Readonly<{ tenantID: TenantID; sessionID: SessionID; ttlSeconds: number }>,
  ): Promise<void>
}
