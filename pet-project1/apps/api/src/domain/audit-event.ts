import {
  APIKeyIDSchema,
  RequestIDSchema,
  SessionIDSchema,
  TenantIDSchema,
} from '@surfgate/contracts'
import { z } from 'zod'

export const AUDIT_EVENT_TYPES = [
  'session.create.requested',
  'session.create.succeeded',
  'session.create.failed',
  'routing.decision',
  'routing.fallback',
  'session.terminate.requested',
  'session.terminated',
  'session.terminate.failed',
  'quota.denied',
  'policy.denied',
] as const
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]
export const AuditEventTypeSchema = z.enum(AUDIT_EVENT_TYPES)

const AuditMetadataSchema = z
  .object({
    outcome: z.enum(['selected', 'no_compatible_runtime']).optional(),
    policyVersion: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u)
      .optional(),
    failureClass: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/u)
      .optional(),
    fallbackRuntime: z.enum(['kitesurf', 'chromium']).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
      .optional(),
    reason: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/u)
      .optional(),
  })
  .strict()
  .readonly()

export const AuditEventSchema = z
  .object({
    tenantID: TenantIDSchema,
    type: AuditEventTypeSchema,
    requestID: RequestIDSchema,
    apiKeyID: APIKeyIDSchema.optional(),
    sessionID: SessionIDSchema.optional(),
    metadata: AuditMetadataSchema.optional(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .readonly()
export type AuditEvent = z.infer<typeof AuditEventSchema>

export interface AuditEventRepository {
  append(event: AuditEvent): Promise<void>
}
