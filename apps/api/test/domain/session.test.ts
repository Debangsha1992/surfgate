import { describe, expect, it } from 'vitest'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { ProviderIDSchema, RuntimeClassSchema } from '@surfgate/provider-core'

import {
  SessionSchema,
  SessionTransitionError,
  applySessionTransition,
} from '../../src/domain/session.js'

const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const CREATED_AT = '2026-08-08T00:00:00.000Z'
const ENCRYPTED_REFERENCE = 'psr.v1.test.abcdefghijklmnop.ciphertext.AAAAAAAAAAAAAAAAAAAAAA'

const PENDING = SessionSchema.parse({
  id: SESSION_ID,
  tenantID: TENANT_ID,
  status: 'pending',
  requestedCapabilities: { javascript: 'required' },
  selectedRuntime: null,
  selectedProvider: null,
  providerSessionReferenceEncrypted: null,
  routingDecisionID: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  connectedAt: null,
  expiresAt: null,
  terminatedAt: null,
  terminationReason: null,
  version: 0,
})

describe('session state machine', () => {
  it('applies the documented allocation lifecycle with semantic timestamps', () => {
    const routing = applySessionTransition(PENDING, {
      type: 'begin_routing',
      at: '2026-08-08T00:00:01.000Z',
    })
    const allocating = applySessionTransition(routing, {
      type: 'begin_allocation',
      at: '2026-08-08T00:00:02.000Z',
      selectedRuntime: RuntimeClassSchema.parse('chromium'),
      selectedProvider: ProviderIDSchema.parse('cloudflare-browser-run'),
    })
    const active = applySessionTransition(allocating, {
      type: 'activate',
      at: '2026-08-08T00:00:03.000Z',
      expiresAt: '2026-08-08T00:05:03.000Z',
      providerSessionReferenceEncrypted: ENCRYPTED_REFERENCE,
    })

    expect(active).toMatchObject({
      status: 'active',
      connectedAt: '2026-08-08T00:00:03.000Z',
      version: 3,
    })
  })

  it('rejects invalid transitions and terminal reactivation', () => {
    expect(() =>
      applySessionTransition(PENDING, {
        type: 'activate',
        at: '2026-08-08T00:00:01.000Z',
        expiresAt: '2026-08-08T00:05:00.000Z',
        providerSessionReferenceEncrypted: ENCRYPTED_REFERENCE,
      }),
    ).toThrow(SessionTransitionError)

    const failed = applySessionTransition(PENDING, {
      type: 'fail',
      at: '2026-08-08T00:00:01.000Z',
      reason: 'allocation_failed',
    })
    expect(() =>
      applySessionTransition(failed, {
        type: 'activate',
        at: '2026-08-08T00:00:02.000Z',
        expiresAt: '2026-08-08T00:05:00.000Z',
        providerSessionReferenceEncrypted: ENCRYPTED_REFERENCE,
      }),
    ).toThrow(SessionTransitionError)
  })

  it('retains an allocated provider reference in a recoverable terminating state', () => {
    const routing = applySessionTransition(PENDING, {
      type: 'begin_routing',
      at: '2026-08-08T00:00:01.000Z',
    })
    const allocating = applySessionTransition(routing, {
      type: 'begin_allocation',
      at: '2026-08-08T00:00:02.000Z',
      selectedRuntime: RuntimeClassSchema.parse('chromium'),
      selectedProvider: ProviderIDSchema.parse('cloudflare-browser-run'),
    })

    expect(
      applySessionTransition(allocating, {
        type: 'retain_for_cleanup',
        at: '2026-08-08T00:00:03.000Z',
        expiresAt: '2026-08-08T00:05:03.000Z',
        providerSessionReferenceEncrypted: ENCRYPTED_REFERENCE,
      }),
    ).toMatchObject({
      status: 'terminating',
      providerSessionReferenceEncrypted: ENCRYPTED_REFERENCE,
    })
  })

  it('makes repeated termination requests idempotent', () => {
    const failed = applySessionTransition(PENDING, {
      type: 'fail',
      at: '2026-08-08T00:00:01.000Z',
      reason: 'allocation_failed',
    })

    expect(
      applySessionTransition(failed, {
        type: 'request_termination',
        at: '2026-08-08T00:00:02.000Z',
      }),
    ).toStrictEqual(failed)
  })

  it('rejects a raw provider reference in the persistence model', () => {
    expect(
      SessionSchema.safeParse({
        ...PENDING,
        providerSessionReferenceEncrypted: 'wss://api.cloudflare.com/secret-session',
      }).success,
    ).toBe(false)
  })

  it('rejects active or terminal rows without their semantic timestamps and protected metadata', () => {
    expect(SessionSchema.safeParse({ ...PENDING, status: 'active' }).success).toBe(false)
    expect(SessionSchema.safeParse({ ...PENDING, status: 'terminated' }).success).toBe(false)
  })

  it('rejects a state transition timestamp older than the current state', () => {
    const routing = applySessionTransition(PENDING, {
      type: 'begin_routing',
      at: '2026-08-08T00:00:02.000Z',
    })

    expect(() =>
      applySessionTransition(routing, {
        type: 'fail',
        at: '2026-08-08T00:00:01.000Z',
        reason: 'stale_event',
      }),
    ).toThrow(SessionTransitionError)
  })
})
