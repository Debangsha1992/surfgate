import {
  APIKeyIDSchema,
  ArtifactIDSchema,
  ManagedTaskResultSchema,
  PublicArtifactSchema,
  RequestIDSchema,
  SessionIDSchema,
  TaskIDSchema,
  TenantIDSchema,
  type ArtifactID,
  type SessionID,
  type TaskID,
  type TenantID,
} from '@surfgate/contracts'
import {
  ArtifactRecordSchema,
  ManagedTaskRecordSchema,
  TaskTransitionError,
  applyTaskTransition,
  type ArtifactRecord,
  type ManagedTaskRecord,
  type ManagedTaskRepository,
  type ManagedTaskSession,
  type TaskCreateClaim,
  type TaskTransitionCommand,
  type TaskTransitionEvent,
} from '@surfgate/task-core'
import type { QueryResultRow } from 'pg'

import type { TaskDatabase, TaskQueryable } from './database.js'

interface TaskRow extends QueryResultRow {
  id: unknown
  tenant_id: unknown
  session_id: unknown
  request_json: unknown
  status: unknown
  attempt_count: unknown
  max_attempts: unknown
  result_json: unknown
  failure_code: unknown
  created_at: unknown
  updated_at: unknown
  started_at: unknown
  completed_at: unknown
  failed_at: unknown
  next_attempt_at: unknown
  claim_token: unknown
  lease_expires_at: unknown
  version: unknown
}
interface ArtifactRow extends QueryResultRow {
  id: unknown
  tenant_id: unknown
  task_id: unknown
  session_id: unknown
  media_type: unknown
  byte_size: unknown
  storage_key: unknown
  sha256: unknown
  created_at: unknown
  expires_at: unknown
}
const TASK_COLUMNS = `id, tenant_id, session_id, request_json, status, attempt_count, max_attempts,
 result_json, failure_code, created_at, updated_at, started_at, completed_at, failed_at,
 next_attempt_at, claim_token, lease_expires_at, version`

function timestamp(value: unknown): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (date === null || !Number.isFinite(date.getTime())) throw new Error('Invalid task timestamp.')
  return date.toISOString()
}
function integer(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed)) throw new Error('Invalid task integer.')
  return parsed
}
async function databaseNow(database: TaskQueryable): Promise<string> {
  const rows = await database.query<{ now: unknown }>('select clock_timestamp() as now')
  const now = timestamp(rows[0]?.now)
  if (now === null) throw new Error('Database clock unavailable.')
  return now
}

function persistedTransitionEvent(command: TaskTransitionCommand, at: string): TaskTransitionEvent {
  if (command.type === 'schedule_retry') {
    if (
      !Number.isSafeInteger(command.retryDelayMs) ||
      command.retryDelayMs < 1 ||
      command.retryDelayMs > 30_000
    ) {
      throw new TaskTransitionError()
    }
    return {
      type: command.type,
      at,
      failureCode: command.failureCode,
      nextAttemptAt: new Date(Date.parse(at) + command.retryDelayMs).toISOString(),
    }
  }
  if (command.type === 'succeed') return { ...command, at }
  if (command.type === 'fail') return { ...command, at }
  return { type: 'cancel', at }
}
function constraint(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = (value as Readonly<Record<string, unknown>>).constraint
  return typeof candidate === 'string' ? candidate : undefined
}
function taskFromRow(row: TaskRow): ManagedTaskRecord {
  return ManagedTaskRecordSchema.parse({
    id: row.id,
    tenantID: row.tenant_id,
    sessionID: row.session_id,
    request: row.request_json,
    status: row.status,
    attemptCount: integer(row.attempt_count),
    maxAttempts: integer(row.max_attempts),
    result: row.result_json,
    failureCode: row.failure_code,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    startedAt: timestamp(row.started_at),
    completedAt: timestamp(row.completed_at),
    failedAt: timestamp(row.failed_at),
    nextAttemptAt: timestamp(row.next_attempt_at),
    claimToken: row.claim_token,
    leaseExpiresAt: timestamp(row.lease_expires_at),
    version: integer(row.version),
  })
}
function artifactFromRow(row: ArtifactRow): ArtifactRecord {
  return ArtifactRecordSchema.parse({
    id: row.id,
    tenantID: row.tenant_id,
    taskID: row.task_id,
    sessionID: row.session_id,
    mediaType: row.media_type,
    byteSize: integer(row.byte_size),
    storageKey: row.storage_key,
    sha256: row.sha256,
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
  })
}

async function appendTaskAudit(
  database: TaskQueryable,
  input: Readonly<{
    task: ManagedTaskRecord
    type:
      | 'task.started'
      | 'task.succeeded'
      | 'task.failed'
      | 'task.cancelled'
      | 'task.retry_scheduled'
      | 'artifact.created'
    at: string
    artifactID?: ArtifactID
    errorCode?: string
  }>,
): Promise<void> {
  await database.query(
    `insert into audit_events
      (tenant_id,event_type,request_id,session_id,task_id,artifact_id,metadata,created_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      input.task.tenantID,
      input.type,
      `req_${input.task.id.slice(4)}`,
      input.task.sessionID,
      input.task.id,
      input.artifactID ?? null,
      JSON.stringify({
        taskType: input.task.request.type,
        attemptCount: input.task.attemptCount,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      }),
      input.at,
    ],
  )
}

async function appendCreateAudit(
  database: TaskQueryable,
  input: Parameters<ManagedTaskRepository['createIdempotent']>[0],
  type: 'task.create.requested' | 'task.queued' | 'quota.denied',
  at: string,
): Promise<void> {
  await database.query(
    `insert into audit_events
      (tenant_id,event_type,request_id,session_id,task_id,api_key_id,metadata,created_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      input.tenantID,
      type,
      RequestIDSchema.parse(input.requestID),
      input.sessionID,
      type === 'quota.denied' ? null : input.task.id,
      APIKeyIDSchema.parse(input.apiKeyID),
      JSON.stringify(
        type === 'quota.denied'
          ? { reason: 'managed_task_quota' }
          : { taskType: input.task.request.type },
      ),
      at,
    ],
  )
}

export class PostgresManagedTaskRepository implements ManagedTaskRepository {
  constructor(private readonly database: TaskDatabase) {}

  async findIdempotentTask(
    input: Parameters<ManagedTaskRepository['findIdempotentTask']>[0],
  ): ReturnType<ManagedTaskRepository['findIdempotentTask']> {
    const rows = await this.database.query<{ request_hash: string; task_id: string }>(
      `select request_hash, task_id from task_create_idempotency
       where tenant_id=$1 and session_id=$2 and idempotency_key=$3`,
      [input.tenantID, input.sessionID, input.idempotencyKey],
    )
    const existing = rows[0]
    if (existing === undefined) return null
    if (existing.request_hash !== input.requestHash) return { kind: 'conflict' }
    const task = await this.findWith(
      this.database,
      input.tenantID,
      TaskIDSchema.parse(existing.task_id),
    )
    if (task === null) throw new Error('Task idempotency record is inconsistent.')
    return { kind: 'existing', task }
  }

  async createIdempotent(
    input: Parameters<ManagedTaskRepository['createIdempotent']>[0],
  ): Promise<TaskCreateClaim> {
    return this.database.transaction(async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`task:${input.tenantID}`])
      const existing = await tx.query<{ request_hash: string; task_id: string }>(
        `select request_hash, task_id from task_create_idempotency
         where tenant_id=$1 and session_id=$2 and idempotency_key=$3`,
        [input.tenantID, input.sessionID, input.idempotencyKey],
      )
      if (existing[0] !== undefined) {
        if (existing[0].request_hash !== input.requestHash) return { kind: 'conflict' }
        const task = await this.findWith(
          tx,
          input.tenantID,
          TaskIDSchema.parse(existing[0].task_id),
        )
        if (task === null) throw new Error('Task idempotency record is inconsistent.')
        return { kind: 'existing', task }
      }
      const now = await databaseNow(tx)
      const sessions = await tx.query<{ status: string; expires_at: unknown }>(
        `select status, expires_at from sessions where tenant_id=$1 and id=$2 for share`,
        [input.tenantID, input.sessionID],
      )
      const session = sessions[0]
      if (session === undefined) return { kind: 'session_not_found' }
      const expiresAt = timestamp(session.expires_at)
      if (session.status !== 'active') return { kind: 'session_not_active' }
      if (expiresAt === null || Date.parse(expiresAt) <= Date.parse(now)) {
        return { kind: 'session_expired' }
      }
      const counts = await tx.query<{ queued: string; recent: string }>(
        `select
           count(*) filter (where status in ('queued','running','retry_pending'))::text as queued,
           count(*) filter (where created_at > $2::timestamptz - interval '1 minute')::text as recent
         from managed_tasks where tenant_id=$1`,
        [input.tenantID, now],
      )
      if (
        Number(counts[0]?.queued ?? 0) >= input.maxQueuedTasks ||
        Number(counts[0]?.recent ?? 0) >= input.maxTasksPerMinute
      ) {
        await appendCreateAudit(tx, input, 'quota.denied', now)
        return { kind: 'quota_exceeded' }
      }
      const task = await this.insert(
        tx,
        ManagedTaskRecordSchema.parse({
          ...input.task,
          createdAt: now,
          updatedAt: now,
        }),
      )
      await tx.query(
        `insert into task_create_idempotency
          (tenant_id, session_id, idempotency_key, request_hash, task_id, created_at)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          input.tenantID,
          input.sessionID,
          input.idempotencyKey,
          input.requestHash,
          task.id,
          task.createdAt,
        ],
      )
      await appendCreateAudit(tx, input, 'task.create.requested', now)
      await appendCreateAudit(tx, input, 'task.queued', now)
      return { kind: 'created', task }
    })
  }

  async findTaskForTenant(tenantID: TenantID, taskID: TaskID): Promise<ManagedTaskRecord | null> {
    return this.findWith(this.database, TenantIDSchema.parse(tenantID), TaskIDSchema.parse(taskID))
  }
  private async findWith(
    db: TaskQueryable,
    tenantID: TenantID,
    taskID: TaskID,
  ): Promise<ManagedTaskRecord | null> {
    const rows = await db.query<TaskRow>(
      `select ${TASK_COLUMNS} from managed_tasks where tenant_id=$1 and id=$2`,
      [tenantID, taskID],
    )
    return rows[0] === undefined ? null : taskFromRow(rows[0])
  }
  private async insert(db: TaskQueryable, raw: ManagedTaskRecord): Promise<ManagedTaskRecord> {
    const task = ManagedTaskRecordSchema.parse(raw)
    const rows = await db.query<TaskRow>(
      `insert into managed_tasks
       (id,tenant_id,session_id,task_type,status,request_json,result_json,attempt_count,max_attempts,
        failure_code,created_at,updated_at,started_at,completed_at,failed_at,next_attempt_at,
        claim_token,lease_expires_at,version)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       returning ${TASK_COLUMNS}`,
      [
        task.id,
        task.tenantID,
        task.sessionID,
        task.request.type,
        task.status,
        JSON.stringify(task.request),
        task.result === null ? null : JSON.stringify(task.result),
        task.attemptCount,
        task.maxAttempts,
        task.failureCode,
        task.createdAt,
        task.updatedAt,
        task.startedAt,
        task.completedAt,
        task.failedAt,
        task.nextAttemptAt,
        task.claimToken,
        task.leaseExpiresAt,
        task.version,
      ],
    )
    return taskFromRow(rows[0]!)
  }

  async transition(
    input: Parameters<ManagedTaskRepository['transition']>[0],
  ): Promise<ManagedTaskRecord> {
    return this.database.transaction(async (tx) => {
      const current = await this.findWith(tx, input.tenantID, input.taskID)
      if (current === null) throw new TaskTransitionError()
      if (
        current.version !== input.expectedVersion ||
        (input.expectedClaimToken !== undefined && current.claimToken !== input.expectedClaimToken)
      )
        throw new TaskTransitionError()
      const at = await databaseNow(tx)
      const event = persistedTransitionEvent(input.event, at)
      const next = applyTaskTransition(current, event)
      const rows = await tx.query<TaskRow>(
        `update managed_tasks set status=$5,attempt_count=$6,result_json=$7::jsonb,failure_code=$8,
         updated_at=$9,started_at=$10,completed_at=$11,failed_at=$12,next_attempt_at=$13,
         claim_token=$14,lease_expires_at=$15,version=$16
         where tenant_id=$1 and id=$2 and version=$3 and ($4::text is null or claim_token=$4)
         returning ${TASK_COLUMNS}`,
        [
          input.tenantID,
          input.taskID,
          current.version,
          input.expectedClaimToken ?? null,
          next.status,
          next.attemptCount,
          next.result === null ? null : JSON.stringify(next.result),
          next.failureCode,
          next.updatedAt,
          next.startedAt,
          next.completedAt,
          next.failedAt,
          next.nextAttemptAt,
          next.claimToken,
          next.leaseExpiresAt,
          next.version,
        ],
      )
      if (rows[0] === undefined) throw new TaskTransitionError()
      const persisted = taskFromRow(rows[0])
      const auditType =
        event.type === 'succeed'
          ? ('task.succeeded' as const)
          : event.type === 'schedule_retry'
            ? ('task.retry_scheduled' as const)
            : event.type === 'cancel'
              ? ('task.cancelled' as const)
              : ('task.failed' as const)
      await appendTaskAudit(tx, {
        task: persisted,
        type: auditType,
        at,
        ...('failureCode' in event ? { errorCode: event.failureCode } : {}),
      })
      return persisted
    })
  }

  async claimNext(
    input: Parameters<ManagedTaskRepository['claimNext']>[0],
  ): Promise<ManagedTaskRecord | null> {
    if (!Number.isSafeInteger(input.leaseTTLms) || input.leaseTTLms < 1_000) {
      throw new Error('Invalid task lease duration.')
    }
    try {
      return await this.database.transaction(async (tx) => {
        const clockRows = await tx.query<{ now: unknown; lease_expires_at: unknown }>(
          `select now, now + ($1::bigint * interval '1 millisecond') as lease_expires_at
             from (select clock_timestamp() as now) database_clock`,
          [input.leaseTTLms],
        )
        const now = timestamp(clockRows[0]?.now)
        const leaseExpiresAt = timestamp(clockRows[0]?.lease_expires_at)
        if (now === null || leaseExpiresAt === null) throw new Error('Database clock unavailable.')
        const exhaustedRows = await tx.query<TaskRow>(
          `update managed_tasks set status='failed', failure_code='TASK_EXECUTION_FAILED',
         failed_at=$1, updated_at=$1, claim_token=null, lease_expires_at=null, version=version+1
         where status='running' and lease_expires_at <= $1 and attempt_count >= max_attempts
         returning ${TASK_COLUMNS}`,
          [now],
        )
        for (const row of exhaustedRows) {
          await appendTaskAudit(tx, {
            task: taskFromRow(row),
            type: 'task.failed',
            at: now,
            errorCode: 'TASK_EXECUTION_FAILED',
          })
        }
        const tenants = await tx.query<{ tenant_id: string }>(
          `select candidate.tenant_id from managed_tasks candidate
         where (candidate.status='queued'
           or (candidate.status='retry_pending' and candidate.next_attempt_at <= $1)
           or (candidate.status='running' and candidate.lease_expires_at <= $1))
         and candidate.attempt_count < candidate.max_attempts
         and (select count(*) from managed_tasks active
           where active.tenant_id=candidate.tenant_id and active.status='running'
             and active.lease_expires_at > $1) < $2
         and not exists (select 1 from managed_tasks active
           where active.tenant_id=candidate.tenant_id
             and active.session_id=candidate.session_id and active.id<>candidate.id
             and active.status='running' and active.lease_expires_at > $1)
         order by case when candidate.status='running' then 0 else 1 end,
           candidate.created_at, candidate.id limit 1`,
          [now, input.maxRunningPerTenant],
        )
        const tenant = tenants[0]?.tenant_id
        if (tenant === undefined) return null
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`task:${tenant}`])
        const running = await tx.query<{ count: string }>(
          `select count(*)::text as count from managed_tasks
         where tenant_id=$1 and status='running' and lease_expires_at > $2`,
          [tenant, now],
        )
        if (Number(running[0]?.count ?? 0) >= input.maxRunningPerTenant) return null
        const rows = await tx.query<TaskRow>(
          `select ${TASK_COLUMNS} from managed_tasks where tenant_id=$1 and
         (status='queued' or (status='retry_pending' and next_attempt_at <= $2)
          or (status='running' and lease_expires_at <= $2)) and attempt_count < max_attempts
         and not exists (
           select 1 from managed_tasks active
           where active.tenant_id=managed_tasks.tenant_id
             and active.session_id=managed_tasks.session_id
             and active.id<>managed_tasks.id
             and active.status='running' and active.lease_expires_at > $2
         )
         order by case when status='running' then 0 else 1 end,
           created_at,id for update skip locked limit 1`,
          [tenant, now],
        )
        if (rows[0] === undefined) return null
        const task = taskFromRow(rows[0])
        await tx.query(`select id from sessions where tenant_id=$1 and id=$2 for update`, [
          task.tenantID,
          task.sessionID,
        ])
        const occupied = await tx.query<{ count: string }>(
          `select count(*)::text as count from managed_tasks
         where tenant_id=$1 and session_id=$2 and id<>$3
           and status='running' and lease_expires_at > $4`,
          [task.tenantID, task.sessionID, task.id, now],
        )
        if (Number(occupied[0]?.count ?? 0) > 0) return null
        const event = {
          type: task.status === 'running' ? ('reclaim' as const) : ('claim' as const),
          at: now,
          claimToken: input.claimToken,
          leaseExpiresAt,
        }
        const next = applyTaskTransition(task, event)
        const updated = await tx.query<TaskRow>(
          `update managed_tasks set status=$3,attempt_count=$4,updated_at=$5,started_at=$6,
         next_attempt_at=null,claim_token=$7,lease_expires_at=$8,version=$9
         where tenant_id=$1 and id=$2 and version=$10 returning ${TASK_COLUMNS}`,
          [
            task.tenantID,
            task.id,
            next.status,
            next.attemptCount,
            next.updatedAt,
            next.startedAt,
            next.claimToken,
            next.leaseExpiresAt,
            next.version,
            task.version,
          ],
        )
        if (updated[0] === undefined) return null
        const persisted = taskFromRow(updated[0])
        await appendTaskAudit(tx, { task: persisted, type: 'task.started', at: now })
        return persisted
      })
    } catch (error: unknown) {
      if (constraint(error) === 'managed_tasks_one_running_per_session_idx') return null
      throw error
    }
  }

  async findExecutionSession(
    tenantID: TenantID,
    sessionID: SessionID,
  ): Promise<ManagedTaskSession | null> {
    const rows = await this.database.query<{
      tenant_id: string
      id: string
      status: string
      selected_runtime: string | null
      expires_at: unknown
      remaining_lifetime_ms: unknown
      provider_session_reference_encrypted: string | null
    }>(
      `select tenant_id,id,status,selected_runtime,expires_at,provider_session_reference_encrypted,
         (case when expires_at is null then 0 else greatest(0,
           floor(extract(epoch from (expires_at - clock_timestamp())) * 1000)) end)::bigint::text
           as remaining_lifetime_ms
       from sessions where tenant_id=$1 and id=$2`,
      [TenantIDSchema.parse(tenantID), SessionIDSchema.parse(sessionID)],
    )
    const row = rows[0]
    return row === undefined
      ? null
      : {
          tenantID: TenantIDSchema.parse(row.tenant_id),
          sessionID: SessionIDSchema.parse(row.id),
          status: row.status,
          selectedRuntime: row.selected_runtime,
          expiresAt: timestamp(row.expires_at),
          remainingLifetimeMs: integer(row.remaining_lifetime_ms),
          providerSessionReferenceEncrypted: row.provider_session_reference_encrypted,
        }
  }

  async insertArtifactAndComplete(
    input: Parameters<ManagedTaskRepository['insertArtifactAndComplete']>[0],
  ): Promise<ManagedTaskRecord> {
    return this.database.transaction(async (tx) => {
      if (
        !Number.isSafeInteger(input.artifactRetentionSeconds) ||
        input.artifactRetentionSeconds < 60
      ) {
        throw new Error('Invalid artifact retention duration.')
      }
      const at = await databaseNow(tx)
      const artifact = ArtifactRecordSchema.parse({
        ...input.artifact,
        createdAt: at,
        expiresAt: new Date(Date.parse(at) + input.artifactRetentionSeconds * 1_000).toISOString(),
      })
      if (input.task.request.type === 'extract') throw new TaskTransitionError()
      const result = ManagedTaskResultSchema.parse({
        type: input.task.request.type,
        artifact: PublicArtifactSchema.parse({
          id: artifact.id,
          mediaType: artifact.mediaType,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
          createdAt: artifact.createdAt,
          expiresAt: artifact.expiresAt,
        }),
      })
      await tx.query(
        `insert into artifacts (id,tenant_id,task_id,session_id,media_type,byte_size,storage_key,sha256,created_at,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id,task_id) do nothing`,
        [
          artifact.id,
          artifact.tenantID,
          artifact.taskID,
          artifact.sessionID,
          artifact.mediaType,
          artifact.byteSize,
          artifact.storageKey,
          artifact.sha256,
          artifact.createdAt,
          artifact.expiresAt,
        ],
      )
      const next = applyTaskTransition(input.task, { type: 'succeed', at, result })
      const rows = await tx.query<TaskRow>(
        `update managed_tasks set status=$5,result_json=$6::jsonb,updated_at=$7,completed_at=$8,
         claim_token=null,lease_expires_at=null,version=$9
         where tenant_id=$1 and id=$2 and version=$3 and claim_token=$4 returning ${TASK_COLUMNS}`,
        [
          input.task.tenantID,
          input.task.id,
          input.task.version,
          input.claimToken,
          next.status,
          JSON.stringify(next.result),
          next.updatedAt,
          next.completedAt,
          next.version,
        ],
      )
      if (rows[0] === undefined) throw new TaskTransitionError()
      const persisted = taskFromRow(rows[0])
      await appendTaskAudit(tx, { task: persisted, type: 'task.succeeded', at })
      await appendTaskAudit(tx, {
        task: persisted,
        type: 'artifact.created',
        at,
        artifactID: artifact.id,
      })
      return persisted
    })
  }

  async findArtifactForTenant(
    tenantID: TenantID,
    artifactID: ArtifactID,
  ): Promise<ArtifactRecord | null> {
    const rows = await this.database.query<ArtifactRow>(
      `select id,tenant_id,task_id,session_id,media_type,byte_size,storage_key,sha256,created_at,expires_at
       from artifacts where tenant_id=$1 and id=$2`,
      [TenantIDSchema.parse(tenantID), ArtifactIDSchema.parse(artifactID)],
    )
    return rows[0] === undefined ? null : artifactFromRow(rows[0])
  }
}
