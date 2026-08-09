import type { AllocationAttemptRepository } from '../domain/allocation-attempt.js'
import type { Queryable } from './database.js'

export class PostgresAllocationAttemptRepository implements AllocationAttemptRepository {
  constructor(private readonly database: Queryable) {}

  async start(input: Parameters<AllocationAttemptRepository['start']>[0]): Promise<void> {
    await this.database.query(
      `insert into session_allocation_attempts
        (tenant_id, session_id, attempt_number, candidate_json, status, started_at)
       values ($1, $2, $3, $4::jsonb, 'started', $5)`,
      [
        input.tenantID,
        input.sessionID,
        input.attemptNumber,
        JSON.stringify(input.candidate),
        input.at,
      ],
    )
  }

  async complete(input: Parameters<AllocationAttemptRepository['complete']>[0]): Promise<void> {
    const rows = await this.database.query(
      `update session_allocation_attempts set status = $4, failure_class = $5,
         fallback_eligible = $6, reason_codes = $7, completed_at = $8
       where tenant_id = $1 and session_id = $2 and attempt_number = $3 and status = 'started'
       returning session_id`,
      [
        input.tenantID,
        input.sessionID,
        input.attemptNumber,
        input.status,
        input.failureClass ?? null,
        input.fallbackEligible ?? null,
        input.reasonCodes,
        input.at,
      ],
    )
    if (rows.length !== 1) throw new Error('Allocation attempt is not active.')
  }

  async countForSession(
    tenantID: Parameters<AllocationAttemptRepository['countForSession']>[0],
    sessionID: Parameters<AllocationAttemptRepository['countForSession']>[1],
  ): Promise<number> {
    const rows = await this.database.query<{ count: string }>(
      'select count(*)::text as count from session_allocation_attempts where tenant_id = $1 and session_id = $2',
      [tenantID, sessionID],
    )
    return Number(rows[0]?.count ?? '0')
  }
}
