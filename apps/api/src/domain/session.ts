import {
  CapabilityRequirementsSchema,
  RoutingDecisionIDSchema,
  SessionIDSchema,
  TenantIDSchema,
} from '@surfgate/contracts'
import { ProviderIDSchema, RuntimeClassSchema } from '@surfgate/provider-core'
import { z } from 'zod'

export const SESSION_STATUSES = [
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
export const SessionStatusSchema = z.enum(SESSION_STATUSES)
export type SessionStatus = z.infer<typeof SessionStatusSchema>

const NullableTimestampSchema = z.iso.datetime({ offset: true }).nullable()
const ProtectedProviderSessionReferenceSchema = z
  .string()
  .min(24)
  .max(32_768)
  .regex(
    /^psr\.v1\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/u,
  )
const EncryptedReferenceSchema = ProtectedProviderSessionReferenceSchema.nullable()

export const SessionSchema = z
  .object({
    id: SessionIDSchema,
    tenantID: TenantIDSchema,
    status: SessionStatusSchema,
    requestedCapabilities: CapabilityRequirementsSchema,
    selectedRuntime: RuntimeClassSchema.nullable(),
    selectedProvider: ProviderIDSchema.nullable(),
    providerSessionReferenceEncrypted: EncryptedReferenceSchema,
    routingDecisionID: RoutingDecisionIDSchema.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    connectedAt: NullableTimestampSchema,
    expiresAt: NullableTimestampSchema,
    terminatedAt: NullableTimestampSchema,
    terminationReason: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/u)
      .nullable(),
    version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((session, context) => {
    if (Date.parse(session.updatedAt) < Date.parse(session.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Session update time cannot precede creation.',
        path: ['updatedAt'],
      })
    }
    if (
      session.connectedAt !== null &&
      Date.parse(session.connectedAt) < Date.parse(session.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Session connection cannot precede creation.',
        path: ['connectedAt'],
      })
    }
    if (
      session.terminatedAt !== null &&
      Date.parse(session.terminatedAt) < Date.parse(session.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Session termination cannot precede creation.',
        path: ['terminatedAt'],
      })
    }
    const activeLifecycle = ['active', 'terminating', 'terminated', 'expired'].includes(
      session.status,
    )
    if (
      activeLifecycle &&
      (session.selectedRuntime === null ||
        session.selectedProvider === null ||
        session.providerSessionReferenceEncrypted === null ||
        session.connectedAt === null ||
        session.expiresAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An allocated session requires complete protected runtime metadata.',
      })
    }

    const terminal = ['terminated', 'expired', 'failed'].includes(session.status)
    if (terminal !== (session.terminatedAt !== null && session.terminationReason !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Session terminal timestamps and reason are inconsistent with status.',
      })
    }
    if (
      session.connectedAt !== null &&
      session.expiresAt !== null &&
      Date.parse(session.expiresAt) <= Date.parse(session.connectedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Session expiry must follow connection.',
        path: ['expiresAt'],
      })
    }
  })
  .readonly()
export type Session = z.infer<typeof SessionSchema>

export const SessionTransitionEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('begin_routing'), at: z.iso.datetime({ offset: true }) }).strict(),
  z
    .object({
      type: z.literal('begin_allocation'),
      at: z.iso.datetime({ offset: true }),
      selectedRuntime: RuntimeClassSchema,
      selectedProvider: ProviderIDSchema,
      routingDecisionID: RoutingDecisionIDSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('begin_fallback_allocation'),
      at: z.iso.datetime({ offset: true }),
      selectedRuntime: RuntimeClassSchema,
      selectedProvider: ProviderIDSchema,
      routingDecisionID: RoutingDecisionIDSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('activate'),
      at: z.iso.datetime({ offset: true }),
      expiresAt: z.iso.datetime({ offset: true }),
      providerSessionReferenceEncrypted: ProtectedProviderSessionReferenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('retain_for_cleanup'),
      at: z.iso.datetime({ offset: true }),
      expiresAt: z.iso.datetime({ offset: true }),
      providerSessionReferenceEncrypted: ProtectedProviderSessionReferenceSchema,
    })
    .strict(),
  z
    .object({ type: z.literal('request_termination'), at: z.iso.datetime({ offset: true }) })
    .strict(),
  z
    .object({
      type: z.literal('complete_termination'),
      at: z.iso.datetime({ offset: true }),
      reason: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u),
    })
    .strict(),
  z
    .object({
      type: z.literal('expire'),
      at: z.iso.datetime({ offset: true }),
      reason: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,127}$/u)
        .default('session_expired'),
    })
    .strict(),
  z
    .object({
      type: z.literal('fail'),
      at: z.iso.datetime({ offset: true }),
      reason: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u),
    })
    .strict(),
])
export type SessionTransitionEvent = z.infer<typeof SessionTransitionEventSchema>

export class SessionTransitionError extends Error {
  readonly code = 'SESSION_INVALID_TRANSITION' as const
  readonly from: SessionStatus
  readonly eventType: SessionTransitionEvent['type']

  constructor(from: SessionStatus, eventType: SessionTransitionEvent['type']) {
    super('The requested session transition is invalid.')
    this.name = 'SessionTransitionError'
    this.from = from
    this.eventType = eventType
  }
}

function next(session: Session, changes: Partial<Session>): Session {
  return SessionSchema.parse({
    ...session,
    ...changes,
    version: session.version + 1,
  })
}

function invalid(session: Session, event: SessionTransitionEvent): never {
  throw new SessionTransitionError(session.status, event.type)
}

export function applySessionTransition(
  rawSession: Session,
  rawEvent: SessionTransitionEvent,
): Session {
  const session = SessionSchema.parse(rawSession)
  const event = SessionTransitionEventSchema.parse(rawEvent)

  if (event.type === 'request_termination') {
    if (['terminating', 'terminated', 'expired', 'failed'].includes(session.status)) {
      return session
    }
    if (Date.parse(event.at) < Date.parse(session.updatedAt)) {
      return invalid(session, event)
    }
    return session.status === 'active'
      ? next(session, { status: 'terminating', updatedAt: event.at })
      : invalid(session, event)
  }
  if (Date.parse(event.at) < Date.parse(session.updatedAt)) {
    return invalid(session, event)
  }
  if (event.type === 'fail') {
    if (['terminated', 'expired', 'failed'].includes(session.status)) {
      return invalid(session, event)
    }
    return next(session, {
      status: 'failed',
      updatedAt: event.at,
      terminatedAt: event.at,
      terminationReason: event.reason,
    })
  }

  switch (session.status) {
    case 'pending':
      return event.type === 'begin_routing'
        ? next(session, { status: 'routing', updatedAt: event.at })
        : invalid(session, event)
    case 'routing':
      return event.type === 'begin_allocation'
        ? next(session, {
            status: 'allocating',
            updatedAt: event.at,
            selectedRuntime: event.selectedRuntime,
            selectedProvider: event.selectedProvider,
            ...(event.routingDecisionID === undefined
              ? {}
              : { routingDecisionID: event.routingDecisionID }),
          })
        : invalid(session, event)
    case 'allocating':
      if (event.type === 'begin_fallback_allocation') {
        return next(session, {
          status: 'fallback_allocating',
          updatedAt: event.at,
          selectedRuntime: event.selectedRuntime,
          selectedProvider: event.selectedProvider,
          ...(event.routingDecisionID === undefined
            ? {}
            : { routingDecisionID: event.routingDecisionID }),
        })
      }
      if (event.type === 'activate') {
        return next(session, {
          status: 'active',
          updatedAt: event.at,
          connectedAt: event.at,
          expiresAt: event.expiresAt,
          providerSessionReferenceEncrypted: event.providerSessionReferenceEncrypted,
        })
      }
      if (event.type === 'retain_for_cleanup') {
        return next(session, {
          status: 'terminating',
          updatedAt: event.at,
          connectedAt: event.at,
          expiresAt: event.expiresAt,
          providerSessionReferenceEncrypted: event.providerSessionReferenceEncrypted,
        })
      }
      return invalid(session, event)
    case 'fallback_allocating':
      if (event.type === 'activate' || event.type === 'retain_for_cleanup') {
        return next(session, {
          status: event.type === 'activate' ? 'active' : 'terminating',
          updatedAt: event.at,
          connectedAt: event.at,
          expiresAt: event.expiresAt,
          providerSessionReferenceEncrypted: event.providerSessionReferenceEncrypted,
        })
      }
      return invalid(session, event)
    case 'active':
      return event.type === 'expire'
        ? next(session, {
            status: 'expired',
            updatedAt: event.at,
            terminatedAt: event.at,
            terminationReason: event.reason,
          })
        : invalid(session, event)
    case 'terminating':
      return event.type === 'complete_termination'
        ? next(session, {
            status: 'terminated',
            updatedAt: event.at,
            terminatedAt: event.at,
            terminationReason: event.reason,
          })
        : invalid(session, event)
    case 'terminated':
    case 'expired':
    case 'failed':
      return invalid(session, event)
  }
}
