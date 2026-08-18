import {
  ArtifactIDSchema,
  IdempotencyKeySchema,
  SessionIDSchema,
  TaskIDSchema,
} from '@surfgate/contracts'
import { z } from 'zod'

export const TaskSessionParametersSchema = z.object({ sessionId: SessionIDSchema }).strict()
export const TaskParametersSchema = z.object({ taskId: TaskIDSchema }).strict()
export const ArtifactParametersSchema = z.object({ artifactId: ArtifactIDSchema }).strict()
export const TaskIdempotencyHeadersSchema = z
  .object({ 'idempotency-key': IdempotencyKeySchema })
  .passthrough()
export const CREATE_TASK_ERROR_STATUSES = Object.freeze([
  400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503,
] as const)
export const GET_TASK_ERROR_STATUSES = Object.freeze([400, 401, 403, 404, 500] as const)
export const GET_ARTIFACT_ERROR_STATUSES = Object.freeze([
  400, 401, 403, 404, 410, 500, 503,
] as const)
