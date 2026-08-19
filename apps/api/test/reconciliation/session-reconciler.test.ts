import { describe, expect, it, vi } from 'vitest'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import {
  ProviderIDSchema,
  ProviderSessionSchema,
  RuntimeClassSchema,
} from '@surfgate/provider-core'
import { createRoutingCandidateID } from '@surfgate/router'
import {
  FakeBrowserProvider,
  createFakeProviderConfig,
  createFakeProviderDescriptor,
} from '@surfgate/testing'

import { SessionSchema, applySessionTransition, type Session } from '../../src/domain/session.js'
import { ProviderRegistry } from '../../src/providers/provider-registry.js'
import {
  SessionReconciler,
  type SessionReconciliationCandidate,
} from '../../src/reconciliation/session-reconciler.js'

const DATABASE_NOW = '2026-08-19T00:10:00.000Z'
const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FAV')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FAV')

function pending(): Session {
  return SessionSchema.parse({
    id: SESSION_ID,
    tenantID: TENANT_ID,
    status: 'pending',
    requestedCapabilities: {},
    selectedRuntime: null,
    selectedProvider: null,
    providerSessionReferenceEncrypted: null,
    routingDecisionID: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    connectedAt: null,
    expiresAt: null,
    terminatedAt: null,
    terminationReason: null,
    version: 0,
  })
}

function fixture(candidate: SessionReconciliationCandidate) {
  let session = candidate.session
  const finalizeReconciledCreate = vi.fn(() => Promise.resolve())
  const descriptor = createFakeProviderDescriptor()
  const provider = new FakeBrowserProvider(createFakeProviderConfig({ descriptor }))
  const terminate = vi.spyOn(provider, 'terminate')
  const providerSession = ProviderSessionSchema.parse({
    reference: {
      providerID: descriptor.providerID,
      runtimeClass: descriptor.runtimeClass,
      providerSessionID: 'reconciliation-session',
    },
    connection: {
      transport: 'websocket',
      endpoint: 'wss://browser.example.test/session/reconciliation-session',
      credentialReference: 'internal-reference',
    },
    allocatedAt: '2026-08-19T00:00:00.000Z',
    expiresAt: '2026-08-19T00:05:00.000Z',
    metadata: {},
  })
  const reconciler = new SessionReconciler({
    sessions: {
      findReconciliationCandidates: () => Promise.resolve([candidate]),
      transitionSessionForTenant: (input) => {
        session = applySessionTransition(session, input.event)
        return Promise.resolve(session)
      },
      finalizeReconciledCreate,
      databaseNow: () => Promise.resolve(DATABASE_NOW),
    },
    registry: new ProviderRegistry([provider]),
    protector: {
      encrypt: () => 'not-used',
      decrypt: () => ({
        candidate: {
          candidateID: createRoutingCandidateID(descriptor),
          providerID: descriptor.providerID,
          runtimeClass: descriptor.runtimeClass,
          ...(descriptor.region === undefined ? {} : { region: descriptor.region }),
          ...(descriptor.configProfile === undefined
            ? {}
            : { configProfile: descriptor.configProfile }),
        },
        session: providerSession,
      }),
    },
    staleAfterMs: 120_000,
    batchSize: 100,
    terminationTimeoutMs: 5_000,
  })
  return {
    reconciler,
    finalizeReconciledCreate,
    terminate,
    get session() {
      return session
    },
  }
}

describe('SessionReconciler', () => {
  it('fails stale pre-allocation state and durably completes idempotency', async () => {
    const setup = fixture({
      session: pending(),
      databaseNow: DATABASE_NOW,
      uncertainAllocation: false,
    })

    await expect(setup.reconciler.runBatch()).resolves.toEqual({
      inspected: 1,
      recovered: 1,
      unresolved: 0,
      suspectedProviderLeaks: 0,
    })
    expect(setup.session).toMatchObject({
      status: 'failed',
      terminationReason: 'reconciliation_timeout',
    })
    expect(setup.finalizeReconciledCreate).toHaveBeenCalledOnce()
  })

  it('finalizes an in-progress create claim after a prior reconciliation crash', async () => {
    const failed = applySessionTransition(pending(), {
      type: 'fail',
      at: DATABASE_NOW,
      reason: 'reconciliation_timeout',
    })
    const setup = fixture({
      session: failed,
      databaseNow: DATABASE_NOW,
      uncertainAllocation: false,
    })

    await expect(setup.reconciler.runBatch()).resolves.toMatchObject({
      recovered: 1,
      unresolved: 0,
    })
    expect(setup.finalizeReconciledCreate).toHaveBeenCalledOnce()
    expect(setup.session.status).toBe('failed')
  })

  it('terminates an expired active provider session idempotently', async () => {
    const protectedReference = 'psr.v1.v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA'
    const active = SessionSchema.parse({
      ...pending(),
      status: 'active',
      selectedRuntime: 'chromium',
      selectedProvider: 'fake-provider',
      providerSessionReferenceEncrypted: protectedReference,
      connectedAt: '2026-08-19T00:00:01.000Z',
      expiresAt: '2026-08-19T00:05:00.000Z',
      updatedAt: '2026-08-19T00:00:01.000Z',
      version: 1,
    })
    const setup = fixture({
      session: active,
      databaseNow: DATABASE_NOW,
      uncertainAllocation: false,
    })

    await expect(setup.reconciler.runBatch()).resolves.toMatchObject({
      recovered: 1,
      unresolved: 0,
    })
    expect(setup.terminate).toHaveBeenCalledOnce()
    expect(setup.session).toMatchObject({
      status: 'terminated',
      terminationReason: 'session_expired',
    })
  })

  it('records uncertain allocation exposure without replaying allocation', async () => {
    const allocating = applySessionTransition(
      applySessionTransition(pending(), {
        type: 'begin_routing',
        at: '2026-08-19T00:00:01.000Z',
      }),
      {
        type: 'begin_allocation',
        at: '2026-08-19T00:00:02.000Z',
        selectedRuntime: RuntimeClassSchema.parse('kitesurf'),
        selectedProvider: ProviderIDSchema.parse('fake-provider'),
      },
    )
    const setup = fixture({
      session: allocating,
      databaseNow: DATABASE_NOW,
      uncertainAllocation: true,
    })

    await expect(setup.reconciler.runBatch()).resolves.toMatchObject({
      recovered: 1,
      suspectedProviderLeaks: 1,
    })
    expect(setup.terminate).not.toHaveBeenCalled()
    expect(setup.session).toMatchObject({
      status: 'failed',
      terminationReason: 'allocation_outcome_uncertain',
    })
  })
})
