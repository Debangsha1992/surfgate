import type { RoutingDecisionID, SessionID, TenantID } from '@surfgate/contracts'
import type { RoutingDecision } from '@surfgate/router'

export type SaveRoutingDecisionInput = Readonly<{
  tenantID: TenantID
  sessionID: SessionID
  decision: RoutingDecision
}>

export interface RoutingDecisionRepository {
  saveRoutingDecisionForTenant(input: SaveRoutingDecisionInput): Promise<RoutingDecision>
  findRoutingDecisionForTenant(
    tenantID: TenantID,
    decisionID: RoutingDecisionID,
  ): Promise<RoutingDecision | null>
}
