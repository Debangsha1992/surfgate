import { z } from 'zod'

import { ArtifactIDSchema, SessionIDSchema, TaskIDSchema } from './ids.js'

export const MANAGED_TASK_TYPES = ['extract', 'screenshot', 'pdf'] as const
export const ManagedTaskTypeSchema = z.enum(MANAGED_TASK_TYPES)
export type ManagedTaskType = z.infer<typeof ManagedTaskTypeSchema>

export const MAX_EXTRACT_TITLE_CHARACTERS = 8_192
export const MAX_EXTRACT_TEXT_CHARACTERS = 1_048_576

const ExtractTaskRequestSchema = z
  .object({
    type: z.literal('extract'),
    selector: z.string().trim().min(1).max(512).optional(),
    allowExperimental: z.boolean().optional(),
  })
  .strict()
  .readonly()

const ScreenshotTaskRequestSchema = z
  .object({
    type: z.literal('screenshot'),
    format: z.enum(['png', 'jpeg']).optional(),
    fullPage: z.boolean().optional(),
    quality: z.number().int().min(1).max(100).optional(),
    allowExperimental: z.boolean().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.format ?? 'png') === 'png' && request.quality !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Image quality is supported only for JPEG screenshots.',
        path: ['quality'],
      })
    }
  })
  .readonly()

const PDFTaskRequestSchema = z
  .object({
    type: z.literal('pdf'),
    landscape: z.boolean().optional(),
    printBackground: z.boolean().optional(),
    widthInches: z.number().finite().min(1).max(17).optional(),
    heightInches: z.number().finite().min(1).max(22).optional(),
    allowExperimental: z.boolean().optional(),
  })
  .strict()
  .readonly()

export const ManagedTaskCreateRequestSchema = z.discriminatedUnion('type', [
  ExtractTaskRequestSchema,
  ScreenshotTaskRequestSchema,
  PDFTaskRequestSchema,
])
export type ManagedTaskCreateRequest = z.infer<typeof ManagedTaskCreateRequestSchema>

export function normalizeManagedTaskCreateRequest(raw: unknown): ManagedTaskCreateRequest {
  const request = ManagedTaskCreateRequestSchema.parse(raw)
  if (request.type === 'extract') {
    return { ...request, allowExperimental: request.allowExperimental ?? false }
  }
  if (request.type === 'screenshot') {
    return {
      ...request,
      format: request.format ?? 'png',
      fullPage: request.fullPage ?? false,
      allowExperimental: request.allowExperimental ?? false,
    }
  }
  return {
    ...request,
    landscape: request.landscape ?? false,
    printBackground: request.printBackground ?? true,
    allowExperimental: request.allowExperimental ?? false,
  }
}

export const MANAGED_TASK_STATUSES = [
  'queued',
  'running',
  'retry_pending',
  'succeeded',
  'failed',
  'cancelled',
] as const
export const ManagedTaskStatusSchema = z.enum(MANAGED_TASK_STATUSES)
export type ManagedTaskStatus = z.infer<typeof ManagedTaskStatusSchema>

export const TASK_FAILURE_CODES = [
  'TASK_INVALID_STATE',
  'TASK_UNSUPPORTED',
  'TASK_EXECUTION_FAILED',
  'TASK_TIMEOUT',
  'TASK_CANCELLED',
  'TASK_OUTPUT_TOO_LARGE',
  'ARTIFACT_STORAGE_FAILED',
  'ARTIFACT_TOO_LARGE',
  'INTERNAL_DEPENDENCY_UNAVAILABLE',
] as const
export const TaskFailureCodeSchema = z.enum(TASK_FAILURE_CODES)
export type TaskFailureCode = z.infer<typeof TaskFailureCodeSchema>

export const PublicArtifactSchema = z
  .object({
    id: ArtifactIDSchema,
    mediaType: z.enum(['image/png', 'image/jpeg', 'application/pdf']),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1_024 * 1_024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((artifact) => Date.parse(artifact.expiresAt) > Date.parse(artifact.createdAt), {
    message: 'Artifact expiry must follow creation.',
    path: ['expiresAt'],
  })
  .readonly()
export type PublicArtifact = z.infer<typeof PublicArtifactSchema>

const ExtractTaskResultSchema = z
  .object({
    type: z.literal('extract'),
    title: z.string().max(MAX_EXTRACT_TITLE_CHARACTERS),
    text: z.string().max(MAX_EXTRACT_TEXT_CHARACTERS),
  })
  .strict()
  .readonly()

const ArtifactTaskResultSchema = z
  .object({
    type: z.enum(['screenshot', 'pdf']),
    artifact: PublicArtifactSchema,
  })
  .strict()
  .readonly()

export const ManagedTaskResultSchema = z.discriminatedUnion('type', [
  ExtractTaskResultSchema,
  ArtifactTaskResultSchema,
])
export type ManagedTaskResult = z.infer<typeof ManagedTaskResultSchema>

const NullableTimestampSchema = z.iso.datetime({ offset: true }).nullable()

export const ManagedTaskSchema = z
  .object({
    id: TaskIDSchema,
    sessionId: SessionIDSchema,
    type: ManagedTaskTypeSchema,
    status: ManagedTaskStatusSchema,
    attemptCount: z.number().int().nonnegative().max(100),
    result: ManagedTaskResultSchema.nullable(),
    failureCode: TaskFailureCodeSchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    startedAt: NullableTimestampSchema,
    completedAt: NullableTimestampSchema,
    failedAt: NullableTimestampSchema,
    nextAttemptAt: NullableTimestampSchema,
  })
  .strict()
  .superRefine((task, context) => {
    const succeeded = task.status === 'succeeded'
    if (succeeded !== (task.result !== null && task.completedAt !== null)) {
      context.addIssue({ code: 'custom', message: 'Successful task result is inconsistent.' })
    }
    const failed = task.status === 'failed'
    if (failed !== (task.failureCode !== null && task.failedAt !== null)) {
      context.addIssue({ code: 'custom', message: 'Failed task metadata is inconsistent.' })
    }
    if (task.result !== null && task.result.type !== task.type) {
      context.addIssue({ code: 'custom', message: 'Task result type does not match task type.' })
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
  })
  .readonly()
export type ManagedTask = z.infer<typeof ManagedTaskSchema>

export const ManagedTaskResponseSchema = z.object({ task: ManagedTaskSchema }).strict().readonly()
export type ManagedTaskResponse = z.infer<typeof ManagedTaskResponseSchema>
