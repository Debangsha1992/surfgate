import { IdempotencyKeySchema, SessionIDSchema } from '@surfgate/contracts'
import { z } from 'zod'

export const SessionParametersSchema = z.object({ sessionId: SessionIDSchema }).strict()
export const IdempotencyHeadersSchema = z
  .object({ 'idempotency-key': IdempotencyKeySchema })
  .passthrough()

export const CREATE_SESSION_ERROR_STATUSES = Object.freeze([
  400, 401, 403, 409, 413, 415, 422, 429, 500, 502, 503, 504,
] as const)
export const GET_SESSION_ERROR_STATUSES = Object.freeze([400, 401, 403, 404, 500] as const)
export const DELETE_SESSION_ERROR_STATUSES = Object.freeze([
  400, 401, 403, 404, 409, 500, 502, 503, 504,
] as const)
export const RELAY_TOKEN_ERROR_STATUSES = Object.freeze([
  400, 401, 403, 404, 409, 500, 503,
] as const)
