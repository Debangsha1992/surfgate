import { describe, expect, it } from 'vitest'

import { ManagedTaskRecordSchema, TaskTransitionError, applyTaskTransition } from '../src/index.js'

const task = ManagedTaskRecordSchema.parse({
  id: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  tenantID: 'ten_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  sessionID: 'ses_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  request: { type: 'extract' },
  status: 'queued',
  attemptCount: 0,
  maxAttempts: 3,
  result: null,
  failureCode: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  failedAt: null,
  nextAttemptAt: null,
  claimToken: null,
  leaseExpiresAt: null,
  version: 0,
})

describe('managed task state machine', () => {
  it('claims one bounded execution attempt', () => {
    const running = applyTaskTransition(task, {
      type: 'claim',
      at: '2026-08-10T00:00:01.000Z',
      claimToken: 'claim_01234567890123456789012345678901',
      leaseExpiresAt: '2026-08-10T00:01:01.000Z',
    })

    expect(running).toMatchObject({ status: 'running', attemptCount: 1, version: 1 })
  })

  it('schedules a bounded retry and rejects attempts beyond the maximum', () => {
    const running = applyTaskTransition(task, {
      type: 'claim',
      at: '2026-08-10T00:00:01.000Z',
      claimToken: 'claim_01234567890123456789012345678901',
      leaseExpiresAt: '2026-08-10T00:01:01.000Z',
    })
    const retry = applyTaskTransition(running, {
      type: 'schedule_retry',
      at: '2026-08-10T00:00:02.000Z',
      nextAttemptAt: '2026-08-10T00:00:10.000Z',
      failureCode: 'ARTIFACT_STORAGE_FAILED',
    })

    expect(retry).toMatchObject({ status: 'retry_pending', attemptCount: 1 })
    expect(() =>
      applyTaskTransition(
        { ...retry, attemptCount: 3 },
        {
          type: 'claim',
          at: '2026-08-10T00:00:10.000Z',
          claimToken: 'claim_11234567890123456789012345678901',
          leaseExpiresAt: '2026-08-10T00:01:10.000Z',
        },
      ),
    ).toThrow(TaskTransitionError)
  })

  it('never reactivates terminal tasks', () => {
    const failed = applyTaskTransition(
      applyTaskTransition(task, {
        type: 'claim',
        at: '2026-08-10T00:00:01.000Z',
        claimToken: 'claim_01234567890123456789012345678901',
        leaseExpiresAt: '2026-08-10T00:01:01.000Z',
      }),
      {
        type: 'fail',
        at: '2026-08-10T00:00:02.000Z',
        failureCode: 'TASK_EXECUTION_FAILED',
      },
    )

    expect(() =>
      applyTaskTransition(failed, {
        type: 'claim',
        at: '2026-08-10T00:00:03.000Z',
        claimToken: 'claim_21234567890123456789012345678901',
        leaseExpiresAt: '2026-08-10T00:01:03.000Z',
      }),
    ).toThrow(TaskTransitionError)
  })

  it('cancels queued work as a terminal idempotency boundary', () => {
    const cancelled = applyTaskTransition(task, {
      type: 'cancel',
      at: '2026-08-10T00:00:01.000Z',
    })

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      completedAt: '2026-08-10T00:00:01.000Z',
    })
    expect(() =>
      applyTaskTransition(cancelled, {
        type: 'claim',
        at: '2026-08-10T00:00:02.000Z',
        claimToken: 'claim_31234567890123456789012345678901',
        leaseExpiresAt: '2026-08-10T00:01:02.000Z',
      }),
    ).toThrow(TaskTransitionError)
  })
})
