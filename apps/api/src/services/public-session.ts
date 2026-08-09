import { PublicSessionSchema, type PublicSession } from '@surfgate/contracts'
import type { RoutingDecision } from '@surfgate/router'

import type { Session } from '../domain/session.js'

export function toPublicSession(
  session: Session,
  decision: RoutingDecision | null,
  allocationAttemptCount: number,
): PublicSession {
  return PublicSessionSchema.parse({
    id: session.id,
    status: session.status,
    runtime:
      session.selectedRuntime === null || session.selectedProvider === null
        ? null
        : { runtimeClass: session.selectedRuntime, providerId: session.selectedProvider },
    routing:
      decision === null
        ? null
        : {
            decisionId: decision.decisionID,
            reasonCodes: decision.reasonCodes,
            fallbackOccurred: allocationAttemptCount > 1,
          },
    createdAt: session.createdAt,
    connectedAt: session.connectedAt,
    expiresAt: session.expiresAt,
    terminatedAt: session.terminatedAt,
  })
}
