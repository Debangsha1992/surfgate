import { z } from 'zod'

import { RuntimePreferenceSchema } from './capabilities.js'
import { RequestIDSchema, type RequestID } from './ids.js'

export const SURFGATE_ERROR_CODES = [
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_UNAUTHORIZED',
  'AUTH_FORBIDDEN',
  'VALIDATION_INVALID_REQUEST',
  'VALIDATION_INVALID_ID',
  'VALIDATION_UNSUPPORTED_CAPABILITY',
  'VALIDATION_IDEMPOTENCY_CONFLICT',
  'POLICY_DENIED',
  'POLICY_TARGET_FORBIDDEN',
  'POLICY_RAW_CDP_DISABLED',
  'QUOTA_EXCEEDED',
  'QUOTA_CONCURRENT_SESSION_LIMIT',
  'ROUTING_NO_COMPATIBLE_RUNTIME',
  'ROUTING_FALLBACK_EXHAUSTED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_AUTHENTICATION_FAILED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UPSTREAM_ERROR',
  'PROVIDER_ALLOCATION_FAILED',
  'SESSION_NOT_FOUND',
  'SESSION_NOT_ACTIVE',
  'SESSION_EXPIRED',
  'SESSION_INVALID_TRANSITION',
  'RELAY_UNAUTHORIZED',
  'RELAY_TOKEN_EXPIRED',
  'RELAY_CONNECTION_FAILED',
  'TASK_NOT_FOUND',
  'TASK_INVALID_STATE',
  'TASK_UNSUPPORTED',
  'TASK_EXECUTION_FAILED',
  'TASK_TIMEOUT',
  'TASK_CANCELLED',
  'TASK_OUTPUT_TOO_LARGE',
  'TASK_FAILED',
  'ARTIFACT_NOT_FOUND',
  'ARTIFACT_STORAGE_FAILED',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACT_UNAVAILABLE',
  'INTERNAL_ERROR',
  'INTERNAL_DATABASE_UNAVAILABLE',
  'INTERNAL_DEPENDENCY_UNAVAILABLE',
] as const

export const SurfGateErrorCodeSchema = z.enum(SURFGATE_ERROR_CODES)
export type SurfGateErrorCode = z.infer<typeof SurfGateErrorCodeSchema>

export const SURFGATE_ERROR_MESSAGES = {
  AUTH_INVALID_CREDENTIALS: 'The supplied credentials are invalid.',
  AUTH_UNAUTHORIZED: 'Authentication is required.',
  AUTH_FORBIDDEN: 'The authenticated principal is not authorized for this operation.',
  VALIDATION_INVALID_REQUEST: 'The request is invalid.',
  VALIDATION_INVALID_ID: 'An identifier is invalid.',
  VALIDATION_UNSUPPORTED_CAPABILITY: 'The request contains an unsupported capability.',
  VALIDATION_IDEMPOTENCY_CONFLICT: 'The idempotency key conflicts with an earlier request.',
  POLICY_DENIED: 'The request was denied by policy.',
  POLICY_TARGET_FORBIDDEN: 'The target is not permitted by policy.',
  POLICY_RAW_CDP_DISABLED: 'Raw CDP access is disabled by production policy.',
  QUOTA_EXCEEDED: 'The applicable quota has been exceeded.',
  QUOTA_CONCURRENT_SESSION_LIMIT: 'The concurrent session limit has been reached.',
  ROUTING_NO_COMPATIBLE_RUNTIME: 'No runtime satisfies the requested capabilities.',
  ROUTING_FALLBACK_EXHAUSTED: 'No eligible fallback runtime completed the request.',
  PROVIDER_UNAVAILABLE: 'The runtime provider is unavailable.',
  PROVIDER_AUTHENTICATION_FAILED: 'The runtime provider could not authenticate the request.',
  PROVIDER_RATE_LIMITED: 'The runtime provider rate limit was reached.',
  PROVIDER_TIMEOUT: 'The runtime provider timed out.',
  PROVIDER_UPSTREAM_ERROR: 'The runtime provider returned an upstream error.',
  PROVIDER_ALLOCATION_FAILED: 'The runtime provider could not allocate a session.',
  SESSION_NOT_FOUND: 'The requested session was not found.',
  SESSION_NOT_ACTIVE: 'The requested session is not active.',
  SESSION_EXPIRED: 'The requested session has expired.',
  SESSION_INVALID_TRANSITION: 'The requested session transition is invalid.',
  RELAY_UNAUTHORIZED: 'The relay connection is not authorized.',
  RELAY_TOKEN_EXPIRED: 'The relay token has expired.',
  RELAY_CONNECTION_FAILED: 'The relay connection failed.',
  TASK_NOT_FOUND: 'The requested task was not found.',
  TASK_INVALID_STATE: 'The task is not in a valid state for this operation.',
  TASK_UNSUPPORTED: 'The selected runtime does not support this task.',
  TASK_EXECUTION_FAILED: 'The task could not be completed.',
  TASK_TIMEOUT: 'The task timed out.',
  TASK_CANCELLED: 'The task was cancelled.',
  TASK_OUTPUT_TOO_LARGE: 'The task output exceeded the permitted size.',
  TASK_FAILED: 'The task failed.',
  ARTIFACT_NOT_FOUND: 'The requested artifact was not found.',
  ARTIFACT_STORAGE_FAILED: 'The task artifact could not be stored.',
  ARTIFACT_TOO_LARGE: 'The task artifact exceeded the permitted size.',
  ARTIFACT_UNAVAILABLE: 'The requested artifact is unavailable.',
  INTERNAL_ERROR: 'An internal error occurred.',
  INTERNAL_DATABASE_UNAVAILABLE: 'A required service is unavailable.',
  INTERNAL_DEPENDENCY_UNAVAILABLE: 'A required service is unavailable.',
} as const satisfies Readonly<Record<SurfGateErrorCode, string>>

const UNSAFE_PROTOTYPE_KEYS = new Set(['constructor', 'proto', 'prototype'])

function normalizeDetailKey(key: string): string {
  return key.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function findUnsafePrototypeKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const unsafeKey = findUnsafePrototypeKey(item)
      if (unsafeKey !== undefined) {
        return unsafeKey
      }
    }

    return undefined
  }

  if (value === null || typeof value !== 'object') {
    return undefined
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (UNSAFE_PROTOTYPE_KEYS.has(normalizeDetailKey(key))) {
      return key
    }

    const nestedUnsafeKey = findUnsafePrototypeKey(nestedValue)
    if (nestedUnsafeKey !== undefined) {
      return nestedUnsafeKey
    }
  }

  return undefined
}

const RawPublicErrorDetailsSchema = z.unknown().superRefine((details, context) => {
  const unsafeKey = findUnsafePrototypeKey(details)
  if (unsafeKey !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Error details contain a forbidden field.',
    })
  }
})

const RejectedRuntimeSchema = RuntimePreferenceSchema.exclude(['auto'])

export const PublicErrorDetailsSchema = RawPublicErrorDetailsSchema.pipe(
  z
    .object({
      rejectedCandidates: z.array(RejectedRuntimeSchema).max(2).optional(),
    })
    .strict(),
).readonly()
export type PublicErrorDetails = z.infer<typeof PublicErrorDetailsSchema>

export const SurfGateErrorBodySchema = z
  .object({
    code: SurfGateErrorCodeSchema,
    message: z.string().min(1).max(256),
    requestId: RequestIDSchema,
    details: PublicErrorDetailsSchema.optional(),
  })
  .strict()
  .superRefine((error, context) => {
    if (error.message !== SURFGATE_ERROR_MESSAGES[error.code]) {
      context.addIssue({
        code: 'custom',
        message: 'The public message does not match the registered error code.',
        path: ['message'],
      })
    }
  })
  .readonly()
export type SurfGateErrorBody = z.infer<typeof SurfGateErrorBodySchema>

export const SurfGateErrorResponseSchema = z
  .object({ error: SurfGateErrorBodySchema })
  .strict()
  .readonly()
export type SurfGateErrorResponse = z.infer<typeof SurfGateErrorResponseSchema>

export function createSurfGateErrorResponse(input: {
  readonly code: SurfGateErrorCode
  readonly requestId: RequestID
  readonly details?: PublicErrorDetails
}): SurfGateErrorResponse {
  const error = {
    code: input.code,
    message: SURFGATE_ERROR_MESSAGES[input.code],
    requestId: input.requestId,
    ...(input.details === undefined ? {} : { details: input.details }),
  }

  return SurfGateErrorResponseSchema.parse({ error })
}
