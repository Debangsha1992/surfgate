import {
  ResolvedProviderConnectionSchema,
  type ProviderSession,
  type ResolvedProviderConnection,
} from '@surfgate/provider-core'
import type { ProviderSessionReferenceProtector } from '@surfgate/security'
import type { ManagedTaskConnectionResolver } from '@surfgate/task-core'

export function createManagedTaskConnectionResolver(
  dependencies: Readonly<{
    protector: ProviderSessionReferenceProtector
    resolveProviderConnection(session: ProviderSession): ResolvedProviderConnection
  }>,
): ManagedTaskConnectionResolver {
  const resolver: ManagedTaskConnectionResolver = {
    resolve(input) {
      try {
        const protectedSession = dependencies.protector.decrypt(input.protectedReference, {
          tenantID: input.tenantID,
          sessionID: input.sessionID,
        })
        if (
          protectedSession.session.reference.providerID !== protectedSession.candidate.providerID ||
          protectedSession.session.reference.runtimeClass !==
            protectedSession.candidate.runtimeClass ||
          protectedSession.session.reference.runtimeClass !== input.expectedRuntime ||
          protectedSession.session.expiresAt !== input.expectedExpiresAt
        ) {
          throw new Error('identity mismatch')
        }
        return Object.freeze({
          session: protectedSession.session,
          connection: ResolvedProviderConnectionSchema.parse(
            dependencies.resolveProviderConnection(protectedSession.session),
          ),
        })
      } catch {
        throw new Error('Managed task provider connection could not be resolved.')
      }
    },
  }
  return Object.freeze(resolver)
}
