import {
  ResolvedProviderConnectionSchema,
  type ProviderSession,
  type ResolvedProviderConnection,
} from '@surfgate/provider-core'
import type { ProviderSessionReferenceProtector } from '@surfgate/security'

import { RelayAuthorizationError, type RelaySessionRecord } from './relay-types.js'

export interface UpstreamConnectionResolver {
  resolve(session: RelaySessionRecord): ResolvedProviderConnection
}

export function createUpstreamConnectionResolver(
  dependencies: Readonly<{
    protector: ProviderSessionReferenceProtector
    resolveProviderConnection(session: ProviderSession): ResolvedProviderConnection
  }>,
): UpstreamConnectionResolver {
  return Object.freeze({
    resolve(session: RelaySessionRecord): ResolvedProviderConnection {
      if (session.providerSessionReferenceEncrypted === null) {
        throw new RelayAuthorizationError('UPSTREAM_CONNECT_FAILED')
      }
      try {
        const protectedSession = dependencies.protector.decrypt(
          session.providerSessionReferenceEncrypted,
          { tenantID: session.tenantID, sessionID: session.sessionID },
        )
        const protectedExpiresAtMs = Date.parse(protectedSession.session.expiresAt)
        const sessionExpiresAtMs =
          session.expiresAt === null ? Number.NaN : Date.parse(session.expiresAt)
        if (
          !Number.isFinite(protectedExpiresAtMs) ||
          !Number.isFinite(sessionExpiresAtMs) ||
          protectedExpiresAtMs !== sessionExpiresAtMs ||
          protectedSession.session.reference.providerID !== protectedSession.candidate.providerID ||
          protectedSession.session.reference.runtimeClass !==
            protectedSession.candidate.runtimeClass
        ) {
          throw new Error('Protected session identity mismatch')
        }
        return ResolvedProviderConnectionSchema.parse(
          dependencies.resolveProviderConnection(protectedSession.session),
        )
      } catch (error: unknown) {
        if (error instanceof RelayAuthorizationError) throw error
        throw new RelayAuthorizationError('UPSTREAM_CONNECT_FAILED')
      }
    },
  })
}
