import type { QueryResultRow } from 'pg'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'

import type {
  ClaimSessionCreateInput,
  SessionCreateClaim,
  SessionCreateCoordinator,
} from '../domain/idempotency.js'
import { PostgresSessionRepository } from './postgres-session-repository.js'
import type { Database, Queryable } from './database.js'

interface IdempotencyRow extends QueryResultRow {
  request_hash: string
  state: 'in_progress' | 'succeeded' | 'failed'
  session_id: string
  http_status: number | null
  error_code: string | null
}

const ACTIVE_QUOTA_STATUSES = [
  'pending',
  'routing',
  'allocating',
  'fallback_allocating',
  'active',
  'terminating',
] as const

export class PostgresSessionCreateCoordinator implements SessionCreateCoordinator {
  constructor(private readonly database: Database) {}

  async claim(input: ClaimSessionCreateInput): Promise<SessionCreateClaim> {
    return this.database.transaction(async (transaction) => {
      await transaction.query('select pg_advisory_xact_lock(hashtext($1))', [input.tenantID])
      const inserted = await transaction.query<QueryResultRow>(
        `insert into session_create_idempotency
          (tenant_id, method, endpoint, idempotency_key, request_hash, owner_token,
           state, lease_expires_at, created_at, updated_at)
         values ($1, 'POST', '/v1/sessions', $2, $3, $4, 'in_progress', $5, $6, $6)
         on conflict do nothing returning tenant_id`,
        [
          input.tenantID,
          input.key,
          input.requestHash,
          input.ownerToken,
          input.leaseExpiresAt,
          input.session.createdAt,
        ],
      )
      if (inserted.length === 0) return this.existing(transaction, input)

      const countRows = await transaction.query<{ count: string }>(
        `select count(*)::text as count from sessions
         where tenant_id = $1 and status = any($2::text[])`,
        [input.tenantID, ACTIVE_QUOTA_STATUSES],
      )
      if (Number(countRows[0]?.count ?? '0') >= input.maxConcurrentSessions) {
        await transaction.query(
          `delete from session_create_idempotency
           where tenant_id = $1 and method = 'POST' and endpoint = '/v1/sessions' and idempotency_key = $2`,
          [input.tenantID, input.key],
        )
        return { kind: 'quota_exceeded' }
      }

      const session = await new PostgresSessionRepository(transaction).insertSession(input.session)
      await transaction.query(
        `update session_create_idempotency set session_id = $3
         where tenant_id = $1 and idempotency_key = $2 and method = 'POST' and endpoint = '/v1/sessions'`,
        [input.tenantID, input.key, session.id],
      )
      return { kind: 'owner', session }
    })
  }

  async complete(input: Parameters<SessionCreateCoordinator['complete']>[0]): Promise<void> {
    const rows = await this.database.query<QueryResultRow>(
      `update session_create_idempotency set state = $5, http_status = $6,
         error_code = $7, updated_at = $8
       where tenant_id = $1 and method = 'POST' and endpoint = '/v1/sessions'
         and idempotency_key = $2 and owner_token = $3 and session_id = $4
         and state = 'in_progress' returning tenant_id`,
      [
        input.tenantID,
        input.key,
        input.ownerToken,
        input.sessionID,
        input.state,
        input.httpStatus,
        input.errorCode ?? null,
        input.at,
      ],
    )
    if (rows.length !== 1) throw new Error('Idempotency completion lost ownership.')
  }

  async waitForCompletion(
    input: Parameters<SessionCreateCoordinator['waitForCompletion']>[0],
  ): Promise<SessionCreateClaim> {
    const started = performance.now()
    while (performance.now() - started < input.timeoutMs) {
      const claim = await this.readExisting(input.tenantID, input.key, input.requestHash)
      if (claim.kind !== 'existing' || claim.state !== 'in_progress') return claim
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    return this.readExisting(input.tenantID, input.key, input.requestHash)
  }

  private async existing(
    transaction: Queryable,
    input: ClaimSessionCreateInput,
  ): Promise<SessionCreateClaim> {
    return this.readExisting(input.tenantID, input.key, input.requestHash, transaction)
  }

  private async readExisting(
    rawTenantID: ClaimSessionCreateInput['tenantID'],
    key: string,
    requestHash: string,
    queryable: Queryable = this.database,
  ): Promise<SessionCreateClaim> {
    const tenantID = TenantIDSchema.parse(rawTenantID)
    const rows = await queryable.query<IdempotencyRow>(
      `select request_hash, state, session_id, http_status, error_code
       from session_create_idempotency
       where tenant_id = $1 and method = 'POST' and endpoint = '/v1/sessions' and idempotency_key = $2`,
      [tenantID, key],
    )
    const row = rows[0]
    if (row === undefined) throw new Error('Idempotency claim disappeared.')
    if (row.request_hash !== requestHash) return { kind: 'conflict' }
    const sessionID = SessionIDSchema.parse(row.session_id)
    const session = await new PostgresSessionRepository(queryable).findSessionForTenant(
      tenantID,
      sessionID,
    )
    if (session === null) throw new Error('Idempotency session is unavailable.')
    return {
      kind: 'existing',
      session,
      state: row.state,
      httpStatus: row.http_status,
      errorCode: row.error_code,
    }
  }
}
