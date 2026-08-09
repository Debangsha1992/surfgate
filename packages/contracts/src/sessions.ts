import { z } from 'zod'

import { CapabilityRequirementsSchema, RuntimeSelectionSchema } from './capabilities.js'
import { RoutingDecisionIDSchema, SessionIDSchema } from './ids.js'

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .brand<'IdempotencyKey'>()
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>

const HTTPTargetURLSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'Target URL must use HTTP or HTTPS.',
  })

const SessionMetadataSchema = z
  .object({
    application: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
      .optional(),
    tags: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u))
      .max(16)
      .superRefine((tags, context) => {
        if (new Set(tags).size !== tags.length) {
          context.addIssue({ code: 'custom', message: 'Metadata tags must be unique.' })
        }
      })
      .readonly()
      .optional(),
  })
  .strict()
  .readonly()

const DEFAULT_RUNTIME = Object.freeze({
  preference: 'auto' as const,
  allowFallback: true,
  allowExperimental: false,
})

export const SessionCreateRequestSchema = z
  .object({
    targetUrl: HTTPTargetURLSchema.optional(),
    capabilities: CapabilityRequirementsSchema.default({}),
    runtime: RuntimeSelectionSchema.default(DEFAULT_RUNTIME),
    maxDurationSeconds: z.number().int().min(1).max(86_400).default(600),
    metadata: SessionMetadataSchema.optional(),
  })
  .strict()
  .readonly()
export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>

export const PUBLIC_SESSION_STATUSES = [
  'pending',
  'routing',
  'allocating',
  'fallback_allocating',
  'active',
  'terminating',
  'terminated',
  'expired',
  'failed',
] as const
export const PublicSessionStatusSchema = z.enum(PUBLIC_SESSION_STATUSES)

const PublicRuntimeSchema = z
  .object({
    runtimeClass: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
  })
  .strict()
  .readonly()

const RoutingReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u)
const PublicRoutingSummarySchema = z
  .object({
    decisionId: RoutingDecisionIDSchema,
    reasonCodes: z.array(RoutingReasonCodeSchema).min(1).max(64).readonly(),
    fallbackOccurred: z.boolean(),
  })
  .strict()
  .readonly()

export const PublicSessionSchema = z
  .object({
    id: SessionIDSchema,
    status: PublicSessionStatusSchema,
    runtime: PublicRuntimeSchema.nullable(),
    routing: PublicRoutingSummarySchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    connectedAt: z.iso.datetime({ offset: true }).nullable(),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
    terminatedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .readonly()
export type PublicSession = z.infer<typeof PublicSessionSchema>

export const SessionCreateResponseSchema = z
  .object({ session: PublicSessionSchema })
  .strict()
  .readonly()
export type SessionCreateResponse = z.infer<typeof SessionCreateResponseSchema>

export const SessionGetResponseSchema = SessionCreateResponseSchema
export type SessionGetResponse = z.infer<typeof SessionGetResponseSchema>

export const SessionTerminationResponseSchema = SessionCreateResponseSchema
export type SessionTerminationResponse = z.infer<typeof SessionTerminationResponseSchema>

export const RelayTokenSchema = z
  .string()
  .min(64)
  .max(4_096)
  .regex(/^sgrt\.v1\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u)
  .brand<'RelayToken'>()
export type RelayToken = z.infer<typeof RelayTokenSchema>

const SurfGateRelayWebSocketURLSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    if (!URL.canParse(value)) {
      context.addIssue({ code: 'custom', message: 'Relay URL is invalid.' })
      return
    }
    const url = new URL(value)
    if (
      (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !/^\/v1\/sessions\/ses_[0-7][0-9A-HJKMNP-TV-Z]{25}\/cdp$/u.test(url.pathname) ||
      url.hostname === 'api.cloudflare.com'
    ) {
      context.addIssue({ code: 'custom', message: 'Relay URL is invalid.' })
    }
  })

export const RelayTokenResponseSchema = z
  .object({
    webSocketUrl: SurfGateRelayWebSocketURLSchema,
    token: RelayTokenSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .readonly()
export type RelayTokenResponse = z.infer<typeof RelayTokenResponseSchema>
