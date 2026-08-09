import { CapabilityRequirementsSchema, RequestIDSchema } from '@surfgate/contracts'
import { z } from 'zod'

import { ProviderIDSchema, RuntimeClassSchema } from './provider-descriptor.js'

const MAX_PROVIDER_OPERATION_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_PROVIDER_SESSION_DURATION_MS = 24 * 60 * 60 * 1_000

const HTTPTargetURLSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  }, 'Target URL must use HTTP or HTTPS')

const InternalWebSocketEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const endpoint = new URL(value)
    return (
      (endpoint.protocol === 'ws:' || endpoint.protocol === 'wss:') &&
      endpoint.username.length === 0 &&
      endpoint.password.length === 0 &&
      endpoint.search.length === 0 &&
      endpoint.hash.length === 0
    )
  }, 'Provider websocket endpoint is invalid')

const ProviderSafeMetadataSchema = z
  .object({
    traceID: z
      .string()
      .regex(/^[0-9a-f]{32}$/u)
      .optional(),
    operationName: z
      .string()
      .regex(/^[a-z][a-z0-9.-]{0,127}$/u)
      .optional(),
  })
  .strict()
  .readonly()

export const ProviderAllocateRequestSchema = z
  .object({
    requestID: RequestIDSchema,
    runtimeClass: RuntimeClassSchema,
    requirements: CapabilityRequirementsSchema,
    allowExperimental: z.boolean(),
    maxSessionDurationMs: z
      .number()
      .int()
      .finite()
      .min(1_000)
      .max(MAX_PROVIDER_SESSION_DURATION_MS),
    targetURL: HTTPTargetURLSchema.optional(),
    region: z.string().trim().min(1).max(64).optional(),
    configProfile: z.string().trim().min(1).max(64).optional(),
    metadata: ProviderSafeMetadataSchema.optional(),
  })
  .strict()
  .readonly()
export type ProviderAllocateRequest = z.infer<typeof ProviderAllocateRequestSchema>

export const ProviderSessionRefSchema = z
  .object({
    providerID: ProviderIDSchema,
    runtimeClass: RuntimeClassSchema,
    providerSessionID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  })
  .strict()
  .readonly()
export type ProviderSessionRef = z.infer<typeof ProviderSessionRefSchema>

export const InternalProviderConnectionSchema = z
  .object({
    transport: z.literal('websocket'),
    endpoint: InternalWebSocketEndpointSchema,
    credentialReference: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u)
      .optional(),
  })
  .strict()
  .readonly()
export type InternalProviderConnection = z.infer<typeof InternalProviderConnectionSchema>

const ProviderSessionMetadataSchema = z
  .object({
    region: z.string().trim().min(1).max(64).optional(),
    configProfile: z.string().trim().min(1).max(64).optional(),
    implementationVersion: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .readonly()

export const ProviderSessionSchema = z
  .object({
    reference: ProviderSessionRefSchema,
    connection: InternalProviderConnectionSchema,
    allocatedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    metadata: ProviderSessionMetadataSchema,
  })
  .strict()
  .refine((session) => Date.parse(session.expiresAt) > Date.parse(session.allocatedAt), {
    message: 'Provider session expiry must be after allocation',
    path: ['expiresAt'],
  })
  .readonly()
export type ProviderSession = z.infer<typeof ProviderSessionSchema>

export const ProviderOperationOptionsSchema = z
  .object({
    timeoutMs: z.number().int().finite().positive().max(MAX_PROVIDER_OPERATION_TIMEOUT_MS),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict()
  .readonly()
export type ProviderOperationOptions = z.infer<typeof ProviderOperationOptionsSchema>

export const ProviderTerminationResultSchema = z.union([
  z
    .object({
      status: z.literal('terminated'),
      reference: ProviderSessionRefSchema,
      terminatedAt: z.iso.datetime({ offset: true }),
    })
    .strict()
    .readonly(),
  z
    .object({
      status: z.literal('already_terminated'),
      reference: ProviderSessionRefSchema,
      terminatedAt: z.iso.datetime({ offset: true }),
    })
    .strict()
    .readonly(),
])
export type ProviderTerminationResult = z.infer<typeof ProviderTerminationResultSchema>
