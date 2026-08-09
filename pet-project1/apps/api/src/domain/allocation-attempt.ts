import type { SessionID, TenantID } from '@surfgate/contracts'
import type {
  FallbackFailureClass,
  RoutingCandidateIdentity,
  RoutingReasonCode,
} from '@surfgate/router'

export interface AllocationAttemptRepository {
  start(
    input: Readonly<{
      tenantID: TenantID
      sessionID: SessionID
      attemptNumber: 0 | 1
      candidate: RoutingCandidateIdentity
      at: string
    }>,
  ): Promise<void>
  complete(
    input: Readonly<{
      tenantID: TenantID
      sessionID: SessionID
      attemptNumber: 0 | 1
      status: 'succeeded' | 'failed'
      failureClass?: FallbackFailureClass
      fallbackEligible?: boolean
      reasonCodes: readonly RoutingReasonCode[]
      at: string
    }>,
  ): Promise<void>
  countForSession(tenantID: TenantID, sessionID: SessionID): Promise<number>
}
