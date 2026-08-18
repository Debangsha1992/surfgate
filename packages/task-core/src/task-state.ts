import {
  ManagedTaskCreateRequestSchema,
  ManagedTaskResultSchema,
  ManagedTaskStatusSchema,
  TaskFailureCodeSchema,
  TaskIDSchema,
  TenantIDSchema,
  SessionIDSchema,
} from '@surfgate/contracts'
import { z } from 'zod'

const NullableTimestampSchema = z.iso.datetime({ offset: true }).nullable()
const ClaimTokenSchema = z.string().regex(/^claim_[A-Za-z0-9_-]{32,128}$/u)

export const ManagedTaskRecordSchema = z
  .object({
    id: TaskIDSchema,
    tenantID: TenantIDSchema,
    sessionID: SessionIDSchema,
    request: ManagedTaskCreateRequestSchema,
    status: ManagedTaskStatusSchema,
    attemptCount: z.number().int().nonnegative().max(100),
    maxAttempts: z.number().int().min(1).max(10),
    result: ManagedTaskResultSchema.nullable(),
    failureCode: TaskFailureCodeSchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    startedAt: NullableTimestampSchema,
    completedAt: NullableTimestampSchema,
    failedAt: NullableTimestampSchema,
    nextAttemptAt: NullableTimestampSchema,
    claimToken: ClaimTokenSchema.nullable(),
    leaseExpiresAt: NullableTimestampSchema,
    version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.attemptCount > task.maxAttempts) {
      context.addIssue({ code: 'custom', message: 'Task attempts exceed the configured maximum.' })
    }
    const claimed = task.status === 'running'
    if (claimed !== (task.claimToken !== null && task.leaseExpiresAt !== null)) {
      context.addIssue({ code: 'custom', message: 'Task claim metadata is inconsistent.' })
    }
    const succeeded = task.status === 'succeeded'
    if (succeeded !== (task.result !== null && task.completedAt !== null)) {
      context.addIssue({ code: 'custom', message: 'Task success metadata is inconsistent.' })
    }
    const failed = task.status === 'failed'
    if (failed !== (task.failureCode !== null && task.failedAt !== null)) {
      context.addIssue({ code: 'custom', message: 'Task failure metadata is inconsistent.' })
    }
    if (task.status === 'retry_pending' && task.nextAttemptAt === null) {
      context.addIssue({ code: 'custom', message: 'Retry-pending task requires a retry time.' })
    }
    if (task.status === 'running' && task.startedAt === null) {
      context.addIssue({ code: 'custom', message: 'Running task requires a start time.' })
    }
    if (task.status === 'cancelled' && task.completedAt === null) {
      context.addIssue({ code: 'custom', message: 'Cancelled task requires a completion time.' })
    }
    if (task.result !== null && task.result.type !== task.request.type) {
      context.addIssue({ code: 'custom', message: 'Task result type does not match its request.' })
    }
  })
  .readonly()
export type ManagedTaskRecord = z.infer<typeof ManagedTaskRecordSchema>

export const TaskTransitionEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('claim'),
      at: z.iso.datetime({ offset: true }),
      claimToken: ClaimTokenSchema,
      leaseExpiresAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal('reclaim'),
      at: z.iso.datetime({ offset: true }),
      claimToken: ClaimTokenSchema,
      leaseExpiresAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal('succeed'),
      at: z.iso.datetime({ offset: true }),
      result: ManagedTaskResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule_retry'),
      at: z.iso.datetime({ offset: true }),
      nextAttemptAt: z.iso.datetime({ offset: true }),
      failureCode: TaskFailureCodeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('fail'),
      at: z.iso.datetime({ offset: true }),
      failureCode: TaskFailureCodeSchema,
    })
    .strict(),
  z.object({ type: z.literal('cancel'), at: z.iso.datetime({ offset: true }) }).strict(),
])
export type TaskTransitionEvent = z.infer<typeof TaskTransitionEventSchema>

export class TaskTransitionError extends Error {
  readonly code = 'TASK_INVALID_STATE' as const

  constructor() {
    super('The task is not in a valid state for this operation.')
    this.name = 'TaskTransitionError'
  }
}

function next(task: ManagedTaskRecord, changes: Partial<ManagedTaskRecord>): ManagedTaskRecord {
  return ManagedTaskRecordSchema.parse({ ...task, ...changes, version: task.version + 1 })
}

export function applyTaskTransition(
  rawTask: ManagedTaskRecord,
  rawEvent: TaskTransitionEvent,
): ManagedTaskRecord {
  const task = ManagedTaskRecordSchema.parse(rawTask)
  const event = TaskTransitionEventSchema.parse(rawEvent)
  if (Date.parse(event.at) < Date.parse(task.updatedAt)) throw new TaskTransitionError()
  if (['succeeded', 'failed', 'cancelled'].includes(task.status)) throw new TaskTransitionError()

  if (event.type === 'claim' || event.type === 'reclaim') {
    const claimable =
      event.type === 'claim'
        ? task.status === 'queued' ||
          (task.status === 'retry_pending' &&
            task.nextAttemptAt !== null &&
            Date.parse(task.nextAttemptAt) <= Date.parse(event.at))
        : task.status === 'running' &&
          task.leaseExpiresAt !== null &&
          Date.parse(task.leaseExpiresAt) <= Date.parse(event.at)
    if (!claimable || task.attemptCount >= task.maxAttempts) throw new TaskTransitionError()
    if (Date.parse(event.leaseExpiresAt) <= Date.parse(event.at)) throw new TaskTransitionError()
    return next(task, {
      status: 'running',
      attemptCount: task.attemptCount + 1,
      updatedAt: event.at,
      startedAt: event.at,
      nextAttemptAt: null,
      claimToken: event.claimToken,
      leaseExpiresAt: event.leaseExpiresAt,
      failureCode: null,
    })
  }
  if (event.type === 'cancel') {
    return next(task, {
      status: 'cancelled',
      updatedAt: event.at,
      completedAt: event.at,
      claimToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
    })
  }
  if (task.status !== 'running') throw new TaskTransitionError()
  if (event.type === 'succeed') {
    if (event.result.type !== task.request.type) throw new TaskTransitionError()
    return next(task, {
      status: 'succeeded',
      result: event.result,
      updatedAt: event.at,
      completedAt: event.at,
      claimToken: null,
      leaseExpiresAt: null,
    })
  }
  if (event.type === 'schedule_retry') {
    if (
      task.attemptCount >= task.maxAttempts ||
      Date.parse(event.nextAttemptAt) <= Date.parse(event.at)
    ) {
      throw new TaskTransitionError()
    }
    return next(task, {
      status: 'retry_pending',
      failureCode: null,
      updatedAt: event.at,
      nextAttemptAt: event.nextAttemptAt,
      claimToken: null,
      leaseExpiresAt: null,
    })
  }
  return next(task, {
    status: 'failed',
    failureCode: event.failureCode,
    updatedAt: event.at,
    failedAt: event.at,
    claimToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
  })
}
