import {
  RoutingDecisionIDSchema,
  SessionIDSchema,
  TenantIDSchema,
  type RoutingDecisionID,
  type TenantID,
} from '@surfgate/contracts'
import { RoutingDecisionSchema, type RoutingDecision } from '@surfgate/router'
import type { QueryResultRow } from 'pg'

import type {
  RoutingDecisionRepository,
  SaveRoutingDecisionInput,
} from '../repositories/routing-decision-repository.js'
import type { Queryable } from './database.js'

interface RoutingDecisionRow extends QueryResultRow {
  decision_json: unknown
}

export class PostgresRoutingDecisionRepository implements RoutingDecisionRepository {
  constructor(private readonly database: Queryable) {}

  async saveRoutingDecisionForTenant(input: SaveRoutingDecisionInput): Promise<RoutingDecision> {
    const tenantID = TenantIDSchema.parse(input.tenantID)
    const sessionID = SessionIDSchema.parse(input.sessionID)
    const decision = RoutingDecisionSchema.parse(input.decision)
    if (decision.tenantID !== tenantID) {
      throw new Error('Routing decision tenant does not match repository scope.')
    }
    const rows = await this.database.query<RoutingDecisionRow>(
      `insert into routing_decisions
        (id, tenant_id, session_id, request_id, policy_version,
         capability_registry_version, selected_provider, selected_runtime,
         decision_json, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       returning decision_json`,
      [
        decision.decisionID,
        tenantID,
        sessionID,
        decision.requestID,
        decision.policyVersion,
        decision.capabilityRegistryVersion,
        decision.selectedCandidate?.providerID ?? null,
        decision.selectedCandidate?.runtimeClass ?? null,
        JSON.stringify(decision),
        decision.createdAt,
      ],
    )
    return RoutingDecisionSchema.parse(rows[0]!.decision_json)
  }

  async findRoutingDecisionForTenant(
    tenantID: TenantID,
    decisionID: RoutingDecisionID,
  ): Promise<RoutingDecision | null> {
    const validatedTenantID = TenantIDSchema.parse(tenantID)
    const validatedDecisionID = RoutingDecisionIDSchema.parse(decisionID)
    const rows = await this.database.query<RoutingDecisionRow>(
      `select decision_json from routing_decisions where tenant_id = $1 and id = $2`,
      [validatedTenantID, validatedDecisionID],
    )
    return rows[0] === undefined ? null : RoutingDecisionSchema.parse(rows[0].decision_json)
  }
}
