import { z } from 'zod'

export const PROVIDER_ERROR_CODES = [
  'PROVIDER_CONFIGURATION_ERROR',
  'PROVIDER_AUTHORIZATION_ERROR',
  'PROVIDER_OPERATION_ABORTED',
  'PROVIDER_OPERATION_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_CAPACITY_EXHAUSTED',
  'PROVIDER_TRANSIENT_UPSTREAM_FAILURE',
  'PROVIDER_UNSUPPORTED',
  'PROVIDER_CONNECTION_FAILED',
  'PROVIDER_INVALID_RESPONSE',
  'PROVIDER_TERMINATION_FAILED',
  'PROVIDER_UNKNOWN_ERROR',
] as const

export const ProviderErrorCodeSchema = z.enum(PROVIDER_ERROR_CODES)
export type ProviderErrorCode = z.infer<typeof ProviderErrorCodeSchema>

export const PROVIDER_OPERATIONS = ['descriptor', 'health', 'allocate', 'terminate'] as const
export const ProviderOperationSchema = z.enum(PROVIDER_OPERATIONS)
export type ProviderOperation = z.infer<typeof ProviderOperationSchema>

export const ProviderDiagnosticCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
export type ProviderDiagnosticCode = z.infer<typeof ProviderDiagnosticCodeSchema>

export const PROVIDER_ERROR_MESSAGES = {
  PROVIDER_CONFIGURATION_ERROR: 'The provider is not configured correctly.',
  PROVIDER_AUTHORIZATION_ERROR: 'The provider rejected authorization.',
  PROVIDER_OPERATION_ABORTED: 'The provider operation was aborted.',
  PROVIDER_OPERATION_TIMEOUT: 'The provider operation timed out.',
  PROVIDER_RATE_LIMITED: 'The provider rate limit was reached.',
  PROVIDER_CAPACITY_EXHAUSTED: 'The provider has no available capacity.',
  PROVIDER_TRANSIENT_UPSTREAM_FAILURE: 'The provider encountered a transient upstream failure.',
  PROVIDER_UNSUPPORTED: 'The provider does not support the requested behavior.',
  PROVIDER_CONNECTION_FAILED: 'The provider connection failed.',
  PROVIDER_INVALID_RESPONSE: 'The provider returned an invalid response.',
  PROVIDER_TERMINATION_FAILED: 'The provider session could not be terminated.',
  PROVIDER_UNKNOWN_ERROR: 'The provider operation failed.',
} as const satisfies Readonly<Record<ProviderErrorCode, string>>

const RETRYABLE_PROVIDER_ERROR_CODES = new Set<ProviderErrorCode>([
  'PROVIDER_OPERATION_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_CAPACITY_EXHAUSTED',
  'PROVIDER_TRANSIENT_UPSTREAM_FAILURE',
  'PROVIDER_CONNECTION_FAILED',
])

export const NormalizedProviderErrorSchema = z
  .object({
    name: z.literal('ProviderError'),
    code: ProviderErrorCodeSchema,
    message: z.string().min(1).max(256),
    operation: ProviderOperationSchema,
    retryable: z.boolean(),
    diagnosticCode: ProviderDiagnosticCodeSchema.optional(),
    retryAfterMs: z.number().int().finite().nonnegative().optional(),
  })
  .strict()
  .superRefine((error, context) => {
    if (error.message !== PROVIDER_ERROR_MESSAGES[error.code]) {
      context.addIssue({ code: 'custom', message: 'Provider error message is not canonical' })
    }
    if (error.retryable !== RETRYABLE_PROVIDER_ERROR_CODES.has(error.code)) {
      context.addIssue({ code: 'custom', message: 'Provider error retryability is inconsistent' })
    }
  })
  .readonly()
export type NormalizedProviderError = z.infer<typeof NormalizedProviderErrorSchema>

export type ProviderErrorOptions = Readonly<{
  code: ProviderErrorCode
  operation: ProviderOperation
  diagnosticCode?: string
  retryAfterMs?: number
}>

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly operation: ProviderOperation
  readonly retryable: boolean
  readonly diagnosticCode: string | undefined
  readonly retryAfterMs: number | undefined

  constructor(options: ProviderErrorOptions) {
    super(PROVIDER_ERROR_MESSAGES[options.code])
    this.name = 'ProviderError'
    this.code = options.code
    this.operation = options.operation
    this.retryable = RETRYABLE_PROVIDER_ERROR_CODES.has(options.code)
    const diagnosticCode = ProviderDiagnosticCodeSchema.safeParse(options.diagnosticCode)
    this.diagnosticCode = diagnosticCode.success ? diagnosticCode.data : undefined
    this.retryAfterMs = options.retryAfterMs

    NormalizedProviderErrorSchema.parse(this.toJSON())
  }

  toJSON(): NormalizedProviderError {
    return NormalizedProviderErrorSchema.parse({
      name: 'ProviderError',
      code: this.code,
      message: this.message,
      operation: this.operation,
      retryable: this.retryable,
      ...(this.diagnosticCode === undefined ? {} : { diagnosticCode: this.diagnosticCode }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    })
  }
}

export function normalizeProviderError(
  error: unknown,
  operation: ProviderOperation,
  fallbackCode: ProviderErrorCode = 'PROVIDER_UNKNOWN_ERROR',
): ProviderError {
  if (error instanceof ProviderError) {
    return error
  }

  return new ProviderError({ code: fallbackCode, operation })
}

export function throwIfProviderOperationAborted(
  signal: AbortSignal | undefined,
  operation: ProviderOperation,
): void {
  if (signal?.aborted === true) {
    throw new ProviderError({ code: 'PROVIDER_OPERATION_ABORTED', operation })
  }
}
