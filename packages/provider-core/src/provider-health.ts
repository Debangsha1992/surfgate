import { z } from 'zod'

export const PROVIDER_HEALTH_STATUSES = ['healthy', 'degraded', 'unavailable'] as const
export const ProviderHealthStatusSchema = z.enum(PROVIDER_HEALTH_STATUSES)
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>

export const PROVIDER_CAPACITY_SIGNALS = [
  'available',
  'constrained',
  'exhausted',
  'unknown',
] as const
export const ProviderCapacitySignalSchema = z.enum(PROVIDER_CAPACITY_SIGNALS)
export type ProviderCapacitySignal = z.infer<typeof ProviderCapacitySignalSchema>

export const PROVIDER_HEALTH_DIAGNOSTIC_CODES = [
  'PROVIDER_HEALTHY',
  'PROVIDER_DEGRADED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_NOT_CONFIGURED',
] as const
export const ProviderHealthDiagnosticCodeSchema = z.enum(PROVIDER_HEALTH_DIAGNOSTIC_CODES)
export type ProviderHealthDiagnosticCode = z.infer<typeof ProviderHealthDiagnosticCodeSchema>

const HEALTH_MEASUREMENT_SHAPE = {
  checkedAt: z.iso.datetime({ offset: true }),
  latencyMs: z.number().finite().nonnegative().optional(),
  retryAfterMs: z.number().int().finite().nonnegative().optional(),
} as const

const HealthyProviderHealthSchema = z
  .object({
    status: z.literal('healthy'),
    configured: z.literal(true),
    diagnosticCode: z.literal('PROVIDER_HEALTHY'),
    capacity: ProviderCapacitySignalSchema,
    ...HEALTH_MEASUREMENT_SHAPE,
  })
  .strict()
  .readonly()

const DegradedProviderHealthSchema = z
  .object({
    status: z.literal('degraded'),
    configured: z.literal(true),
    diagnosticCode: z.literal('PROVIDER_DEGRADED'),
    capacity: ProviderCapacitySignalSchema,
    ...HEALTH_MEASUREMENT_SHAPE,
  })
  .strict()
  .readonly()

const UnavailableProviderHealthSchema = z
  .object({
    status: z.literal('unavailable'),
    configured: z.literal(true),
    diagnosticCode: z.literal('PROVIDER_UNAVAILABLE'),
    capacity: ProviderCapacitySignalSchema,
    ...HEALTH_MEASUREMENT_SHAPE,
  })
  .strict()
  .readonly()

const UnconfiguredProviderHealthSchema = z
  .object({
    status: z.literal('unavailable'),
    configured: z.literal(false),
    diagnosticCode: z.literal('PROVIDER_NOT_CONFIGURED'),
    capacity: z.literal('unknown'),
    ...HEALTH_MEASUREMENT_SHAPE,
  })
  .strict()
  .readonly()

export const ProviderHealthSchema = z.union([
  HealthyProviderHealthSchema,
  DegradedProviderHealthSchema,
  UnavailableProviderHealthSchema,
  UnconfiguredProviderHealthSchema,
])
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>
