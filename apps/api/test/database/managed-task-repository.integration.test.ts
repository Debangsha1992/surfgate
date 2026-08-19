import { ManagedTaskRecordSchema } from '@surfgate/task-core'
import { PostgresManagedTaskRepository } from '@surfgate/task-postgres'
import {
  APIKeyIDSchema,
  RequestIDSchema,
  SessionIDSchema,
  TaskIDSchema,
  TenantIDSchema,
} from '@surfgate/contracts'
import { afterEach, expect, it } from 'vitest'

import { database, describeWithDatabase } from './fixture.js'

const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FE1')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FE1')
const TASK_ID = TaskIDSchema.parse('tsk_01ARZ3NDEKTSV4RRFFQ69G5FE1')
const TASK_ID_2 = TaskIDSchema.parse('tsk_01ARZ3NDEKTSV4RRFFQ69G5FE2')
const API_KEY_ID = APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FE1')
const REQUEST_ID = RequestIDSchema.parse('req_01ARZ3NDEKTSV4RRFFQ69G5FE1')

describeWithDatabase('tenant-scoped managed task persistence', () => {
  afterEach(async () => {
    await database.query('delete from tenants where id = $1', [TENANT_ID])
  })

  it('creates exactly one task for concurrent idempotent claims', async () => {
    const repository = new PostgresManagedTaskRepository(database)
    const now = '2026-08-10T00:00:00.000Z'
    await database.query(
      `insert into tenants (id, name, status, plan, created_at, updated_at)
       values ($1, 'Task tenant', 'active', 'development', $2, $2)`,
      [TENANT_ID, now],
    )
    await database.query(
      `insert into sessions
        (id, tenant_id, status, requested_capabilities, selected_runtime, selected_provider,
         provider_session_reference_encrypted, created_at, updated_at, connected_at, expires_at,
         version)
       values ($1, $2, 'active', '{}'::jsonb, 'chromium', 'cloudflare-browser-run',
         'psr.v1.test.0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
         clock_timestamp(), clock_timestamp(), clock_timestamp(),
         clock_timestamp() + interval '1 hour', 0)`,
      [SESSION_ID, TENANT_ID],
    )
    const task = ManagedTaskRecordSchema.parse({
      id: TASK_ID,
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      request: { type: 'extract' },
      status: 'queued',
      attemptCount: 0,
      maxAttempts: 3,
      result: null,
      failureCode: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      nextAttemptAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      version: 0,
    })
    const input = {
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      idempotencyKey: 'same-key',
      requestHash: 'a'.repeat(64),
      requestID: REQUEST_ID,
      apiKeyID: API_KEY_ID,
      task,
      maxQueuedTasks: 10,
      maxTasksPerMinute: 100,
    } as const

    const [first, second] = await Promise.all([
      repository.createIdempotent(input),
      repository.createIdempotent(input),
    ])

    expect([first.kind, second.kind].toSorted()).toEqual(['created', 'existing'])
    const rows = await database.query<{ count: string }>(
      'select count(*)::text as count from managed_tasks where tenant_id=$1 and id=$2',
      [TENANT_ID, TASK_ID],
    )
    expect(rows[0]?.count).toBe('1')
    const claimed = await repository.claimNext({
      claimToken: 'claim_01234567890123456789012345678901',
      leaseTTLms: 60_000,
      maxRunningPerTenant: 5,
    })
    expect(claimed?.traceParent).toBe(task.traceParent)
    const completed = await repository.transition({
      tenantID: TENANT_ID,
      taskID: TASK_ID,
      expectedVersion: claimed!.version,
      expectedClaimToken: claimed!.claimToken!,
      event: { type: 'succeed', result: { type: 'extract', title: 'done', text: 'done' } },
    })
    expect(Math.abs(Date.parse(completed.completedAt!) - Date.now())).toBeLessThan(5_000)
  })

  it('uses the database clock when rejecting an expired session', async () => {
    const repository = new PostgresManagedTaskRepository(database)
    const callerClock = '2020-01-01T00:00:00.000Z'
    await database.query(
      `insert into tenants (id, name, status, plan, created_at, updated_at)
       values ($1, 'Skewed clock tenant', 'active', 'development', clock_timestamp(), clock_timestamp())`,
      [TENANT_ID],
    )
    await database.query(
      `insert into sessions
        (id, tenant_id, status, requested_capabilities, selected_runtime, selected_provider,
         provider_session_reference_encrypted, created_at, updated_at, connected_at, expires_at,
         version)
       values ($1, $2, 'active', '{}'::jsonb, 'chromium', 'cloudflare-browser-run',
         'psr.v1.test.0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
         clock_timestamp() - interval '1 hour', clock_timestamp(),
         clock_timestamp() - interval '1 hour',
         clock_timestamp() - interval '1 second', 0)`,
      [SESSION_ID, TENANT_ID],
    )
    const task = ManagedTaskRecordSchema.parse({
      id: TASK_ID,
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      request: { type: 'extract' },
      status: 'queued',
      attemptCount: 0,
      maxAttempts: 3,
      result: null,
      failureCode: null,
      createdAt: callerClock,
      updatedAt: callerClock,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      nextAttemptAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      version: 0,
    })

    const result = await repository.createIdempotent({
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      idempotencyKey: 'skewed-clock',
      requestHash: 'd'.repeat(64),
      requestID: REQUEST_ID,
      apiKeyID: API_KEY_ID,
      task,
      maxQueuedTasks: 10,
      maxTasksPerMinute: 100,
    })

    expect(result).toEqual({ kind: 'session_expired' })
  })

  it('allows only one worker attempt per browser session at a time', async () => {
    const repository = new PostgresManagedTaskRepository(database)
    const now = '2026-08-10T00:00:00.000Z'
    await database.query(
      `insert into tenants (id, name, status, plan, created_at, updated_at)
       values ($1, 'Worker tenant', 'active', 'development', $2, $2)`,
      [TENANT_ID, now],
    )
    await database.query(
      `insert into sessions
        (id, tenant_id, status, requested_capabilities, selected_runtime, selected_provider,
         provider_session_reference_encrypted, created_at, updated_at, connected_at, expires_at,
         version)
       values ($1, $2, 'active', '{}'::jsonb, 'chromium', 'cloudflare-browser-run',
         'psr.v1.test.0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
         clock_timestamp(), clock_timestamp(), clock_timestamp(),
         clock_timestamp() + interval '1 hour', 0)`,
      [SESSION_ID, TENANT_ID],
    )
    const base = ManagedTaskRecordSchema.parse({
      id: TASK_ID,
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      request: { type: 'extract' },
      status: 'queued',
      attemptCount: 0,
      maxAttempts: 3,
      result: null,
      failureCode: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      nextAttemptAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      version: 0,
    })
    for (const [id, key] of [
      [TASK_ID, 'task-one'],
      [TASK_ID_2, 'task-two'],
    ] as const) {
      await repository.createIdempotent({
        tenantID: TENANT_ID,
        sessionID: SESSION_ID,
        idempotencyKey: key,
        requestHash: id === TASK_ID ? 'a'.repeat(64) : 'b'.repeat(64),
        requestID: REQUEST_ID,
        apiKeyID: API_KEY_ID,
        task: ManagedTaskRecordSchema.parse({ ...base, id }),
        maxQueuedTasks: 10,
        maxTasksPerMinute: 100,
      })
    }

    const claims = await Promise.all([
      repository.claimNext({
        claimToken: 'claim_01234567890123456789012345678901',
        leaseTTLms: 60_000,
        maxRunningPerTenant: 5,
      }),
      repository.claimNext({
        claimToken: 'claim_11234567890123456789012345678901',
        leaseTTLms: 60_000,
        maxRunningPerTenant: 5,
      }),
    ])

    expect(claims.filter((claim) => claim !== null).map((claim) => claim?.id)).toEqual([TASK_ID])
  })

  it('reclaims an expired worker lease without allowing the stale owner to complete', async () => {
    const repository = new PostgresManagedTaskRepository(database)
    const now = '2026-08-10T00:00:00.000Z'
    await database.query(
      `insert into tenants (id, name, status, plan, created_at, updated_at)
       values ($1, 'Recovery tenant', 'active', 'development', $2, $2)`,
      [TENANT_ID, now],
    )
    await database.query(
      `insert into sessions
        (id, tenant_id, status, requested_capabilities, selected_runtime, selected_provider,
         provider_session_reference_encrypted, created_at, updated_at, connected_at, expires_at,
         version)
       values ($1, $2, 'active', '{}'::jsonb, 'chromium', 'cloudflare-browser-run',
         'psr.v1.test.0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA',
         clock_timestamp(), clock_timestamp(), clock_timestamp(),
         clock_timestamp() + interval '1 hour', 0)`,
      [SESSION_ID, TENANT_ID],
    )
    const queued = ManagedTaskRecordSchema.parse({
      id: TASK_ID,
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      request: { type: 'extract' },
      status: 'queued',
      attemptCount: 0,
      maxAttempts: 3,
      result: null,
      failureCode: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      nextAttemptAt: null,
      claimToken: null,
      leaseExpiresAt: null,
      version: 0,
    })
    await repository.createIdempotent({
      tenantID: TENANT_ID,
      sessionID: SESSION_ID,
      idempotencyKey: 'recover-task',
      requestHash: 'c'.repeat(64),
      requestID: REQUEST_ID,
      apiKeyID: API_KEY_ID,
      task: queued,
      maxQueuedTasks: 10,
      maxTasksPerMinute: 100,
    })
    const first = await repository.claimNext({
      claimToken: 'claim_01234567890123456789012345678901',
      leaseTTLms: 60_000,
      maxRunningPerTenant: 5,
    })
    await database.query(
      `update managed_tasks set lease_expires_at=clock_timestamp() - interval '1 second'
       where tenant_id=$1 and id=$2`,
      [TENANT_ID, TASK_ID],
    )
    const recovered = await repository.claimNext({
      claimToken: 'claim_11234567890123456789012345678901',
      leaseTTLms: 60_000,
      maxRunningPerTenant: 5,
    })

    expect(first).toMatchObject({ id: TASK_ID, attemptCount: 1, version: 1 })
    expect(recovered).toMatchObject({ id: TASK_ID, attemptCount: 2, version: 2 })
    await expect(
      repository.transition({
        tenantID: TENANT_ID,
        taskID: TASK_ID,
        expectedVersion: first!.version,
        expectedClaimToken: first!.claimToken!,
        event: {
          type: 'succeed',
          result: { type: 'extract', title: 'stale', text: 'stale' },
        },
      }),
    ).rejects.toMatchObject({ code: 'TASK_INVALID_STATE' })

    await database.query(
      `update managed_tasks set lease_expires_at=clock_timestamp() - interval '1 second',
       max_attempts=attempt_count where tenant_id=$1 and id=$2`,
      [TENANT_ID, TASK_ID],
    )
    await expect(
      repository.claimNext({
        claimToken: 'claim_21234567890123456789012345678901',
        leaseTTLms: 60_000,
        maxRunningPerTenant: 5,
      }),
    ).resolves.toBeNull()
    const failed = await repository.findTaskForTenant(TENANT_ID, TASK_ID)
    const audits = await database.query<{ count: string }>(
      `select count(*)::text as count from audit_events
       where tenant_id=$1 and task_id=$2 and event_type='task.failed'`,
      [TENANT_ID, TASK_ID],
    )
    expect(failed).toMatchObject({ status: 'failed', failureCode: 'TASK_EXECUTION_FAILED' })
    expect(audits[0]?.count).toBe('1')
  })
})
