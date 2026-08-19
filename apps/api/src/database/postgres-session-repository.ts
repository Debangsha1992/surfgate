import { SessionIDSchema, TenantIDSchema, type SessionID, type TenantID } from '@surfgate/contracts'
import type { QueryResultRow } from 'pg'

import {
  SessionSchema,
  SessionTransitionError,
  applySessionTransition,
  type Session,
} from '../domain/session.js'
import {
  SessionNotFoundError,
  SessionTransitionConflictError,
  type SessionRepository,
  type TransitionSessionInput,
} from '../repositories/session-repository.js'
import type { Queryable } from './database.js'
import { nullableTimestampFromRow, safeIntegerFromRow, timestampFromRow } from './row-values.js'
import type {
  SessionReconciliationCandidate,
  SessionReconciliationRepository,
} from '../reconciliation/session-reconciler.js'

interface SessionRow extends QueryResultRow {
  id: unknown
  tenant_id: unknown
  status: unknown
  requested_capabilities: unknown
  selected_runtime: unknown
  selected_provider: unknown
  provider_session_reference_encrypted: unknown
  routing_decision_id: unknown
  created_at: unknown
  updated_at: unknown
  connected_at: unknown
  expires_at: unknown
  terminated_at: unknown
  termination_reason: unknown
  version: unknown
}

const SESSION_COLUMNS = `id, tenant_id, status, requested_capabilities,
  selected_runtime, selected_provider, provider_session_reference_encrypted,
  routing_decision_id, created_at, updated_at, connected_at, expires_at,
  terminated_at, termination_reason, version`

function sessionFromRow(row: SessionRow): Session {
  return SessionSchema.parse({
    id: row.id,
    tenantID: row.tenant_id,
    status: row.status,
    requestedCapabilities: row.requested_capabilities,
    selectedRuntime: row.selected_runtime,
    selectedProvider: row.selected_provider,
    providerSessionReferenceEncrypted: row.provider_session_reference_encrypted,
    routingDecisionID: row.routing_decision_id,
    createdAt: timestampFromRow(row.created_at),
    updatedAt: timestampFromRow(row.updated_at),
    connectedAt: nullableTimestampFromRow(row.connected_at),
    expiresAt: nullableTimestampFromRow(row.expires_at),
    terminatedAt: nullableTimestampFromRow(row.terminated_at),
    terminationReason: row.termination_reason,
    version: safeIntegerFromRow(row.version),
  })
}

export class PostgresSessionRepository
  implements SessionRepository, SessionReconciliationRepository
{
  constructor(private readonly database: Queryable) {}

  async insertSession(rawSession: Session): Promise<Session> {
    const session = SessionSchema.parse(rawSession)
    const rows = await this.database.query<SessionRow>(
      `insert into sessions
        (id, tenant_id, status, requested_capabilities, selected_runtime,
         selected_provider, provider_session_reference_encrypted, routing_decision_id,
         created_at, updated_at, connected_at, expires_at, terminated_at,
         termination_reason, version)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       returning ${SESSION_COLUMNS}`,
      [
        session.id,
        session.tenantID,
        session.status,
        JSON.stringify(session.requestedCapabilities),
        session.selectedRuntime,
        session.selectedProvider,
        session.providerSessionReferenceEncrypted,
        session.routingDecisionID,
        session.createdAt,
        session.updatedAt,
        session.connectedAt,
        session.expiresAt,
        session.terminatedAt,
        session.terminationReason,
        session.version,
      ],
    )
    return sessionFromRow(rows[0]!)
  }

  async findSessionForTenant(tenantID: TenantID, sessionID: SessionID): Promise<Session | null> {
    const validatedTenantID = TenantIDSchema.parse(tenantID)
    const validatedSessionID = SessionIDSchema.parse(sessionID)
    const rows = await this.database.query<SessionRow>(
      `select ${SESSION_COLUMNS} from sessions where tenant_id = $1 and id = $2`,
      [validatedTenantID, validatedSessionID],
    )
    return rows[0] === undefined ? null : sessionFromRow(rows[0])
  }

  async transitionSessionForTenant(input: TransitionSessionInput): Promise<Session> {
    const tenantID = TenantIDSchema.parse(input.tenantID)
    const sessionID = SessionIDSchema.parse(input.sessionID)
    const current = await this.findSessionForTenant(tenantID, sessionID)
    if (current === null) {
      throw new SessionNotFoundError()
    }
    if (current.version !== input.expectedVersion) {
      return this.resolveConflict(current, input)
    }
    const next = applySessionTransition(current, input.event)
    if (next === current || next.version === current.version) {
      return current
    }

    const rows = await this.database.query<SessionRow>(
      `update sessions set
         status = $5,
         selected_runtime = $6,
         selected_provider = $7,
         provider_session_reference_encrypted = $8,
         routing_decision_id = $9,
         updated_at = $10,
         connected_at = $11,
         expires_at = $12,
         terminated_at = $13,
         termination_reason = $14,
         version = $15
       where tenant_id = $1 and id = $2 and version = $3 and status = $4
       returning ${SESSION_COLUMNS}`,
      [
        tenantID,
        sessionID,
        current.version,
        current.status,
        next.status,
        next.selectedRuntime,
        next.selectedProvider,
        next.providerSessionReferenceEncrypted,
        next.routingDecisionID,
        next.updatedAt,
        next.connectedAt,
        next.expiresAt,
        next.terminatedAt,
        next.terminationReason,
        next.version,
      ],
    )
    if (rows[0] !== undefined) {
      return sessionFromRow(rows[0])
    }
    const competing = await this.findSessionForTenant(tenantID, sessionID)
    if (competing === null) {
      throw new SessionNotFoundError()
    }
    return this.resolveConflict(competing, input)
  }

  async findReconciliationCandidates(
    input: Readonly<{
      staleAfterMs: number
      batchSize: number
    }>,
  ): Promise<readonly SessionReconciliationCandidate[]> {
    if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 1_000) {
      throw new Error('Session reconciliation age is invalid.')
    }
    if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 1_000) {
      throw new Error('Session reconciliation batch size is invalid.')
    }
    const rows = await this.database.query<
      SessionRow & { database_now: unknown; uncertain_allocation: boolean }
    >(
      `with reconciliation_clock as materialized (
         select clock_timestamp() as database_now,
           clock_timestamp() - ($1::bigint * interval '1 millisecond') as stale_before
       ), reconciliation_candidates as materialized (
         (select sessions.tenant_id, sessions.id, sessions.updated_at as priority_at
          from sessions, reconciliation_clock
          where status in ('pending', 'routing', 'allocating', 'fallback_allocating')
            and updated_at <= stale_before
          order by updated_at, tenant_id, id
          limit $2)
         union all
         (select sessions.tenant_id, sessions.id, sessions.updated_at as priority_at
          from sessions, reconciliation_clock
          where status = 'terminating' and updated_at <= stale_before
          order by updated_at, tenant_id, id
          limit $2)
         union all
         (select sessions.tenant_id, sessions.id, sessions.expires_at as priority_at
          from sessions, reconciliation_clock
          where status = 'active' and expires_at <= database_now
          order by expires_at, updated_at, tenant_id, id
          limit $2)
         union all
         (select sessions.tenant_id, sessions.id, create_claim.lease_expires_at as priority_at
          from session_create_idempotency create_claim
          join sessions on sessions.tenant_id = create_claim.tenant_id
            and sessions.id = create_claim.session_id
          cross join reconciliation_clock
          where create_claim.state = 'in_progress'
            and create_claim.lease_expires_at <= database_now
            and sessions.status = 'failed'
            and sessions.updated_at <= stale_before
          order by create_claim.lease_expires_at, create_claim.tenant_id, create_claim.session_id
          limit $2)
       ), selected_candidates as materialized (
         select tenant_id as selected_tenant_id, id as selected_session_id
         from reconciliation_candidates
         order by priority_at, tenant_id, id
         limit $2
       )
       select ${SESSION_COLUMNS}, reconciliation_clock.database_now,
         (status in ('allocating', 'fallback_allocating') and exists (
           select 1 from session_allocation_attempts attempt
           where attempt.tenant_id = sessions.tenant_id
             and attempt.session_id = sessions.id and attempt.status = 'started'
         )) as uncertain_allocation
       from sessions
       join selected_candidates
         on selected_candidates.selected_tenant_id = sessions.tenant_id
         and selected_candidates.selected_session_id = sessions.id
       cross join reconciliation_clock
       order by sessions.updated_at, sessions.tenant_id, sessions.id`,
      [input.staleAfterMs, input.batchSize],
    )
    return Object.freeze(
      rows.map((row) => ({
        session: sessionFromRow(row),
        databaseNow: timestampFromRow(row.database_now),
        uncertainAllocation: row.uncertain_allocation,
      })),
    )
  }

  async finalizeReconciledCreate(
    input: Readonly<{
      tenantID: TenantID
      sessionID: SessionID
      at: string
    }>,
  ): Promise<void> {
    const tenantID = TenantIDSchema.parse(input.tenantID)
    const sessionID = SessionIDSchema.parse(input.sessionID)
    await this.database.query(
      `update session_create_idempotency
       set state='failed', http_status=503, error_code='PROVIDER_ALLOCATION_FAILED', updated_at=$3
       where tenant_id=$1 and session_id=$2 and state='in_progress'`,
      [tenantID, sessionID, input.at],
    )
  }

  async databaseNow(): Promise<string> {
    const rows = await this.database.query<{ database_now: unknown }>(
      'select clock_timestamp() as database_now',
    )
    return timestampFromRow(rows[0]?.database_now)
  }

  private resolveConflict(current: Session, input: TransitionSessionInput): Session {
    try {
      const resolved = applySessionTransition(current, input.event)
      if (resolved.version === current.version) {
        return current
      }
    } catch (error: unknown) {
      if (!(error instanceof SessionTransitionError)) {
        throw error
      }
    }
    throw new SessionTransitionConflictError()
  }
}
