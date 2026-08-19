import { afterEach, expect, it } from 'vitest'

import { SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'

import { SessionSchema } from '../../src/domain/session.js'
import { PostgresSessionRepository } from '../../src/database/postgres-session-repository.js'
import { PostgresTenantRepository } from '../../src/database/postgres-tenant-repository.js'
import { TenantSchema } from '../../src/domain/tenant.js'
import { database, describeWithDatabase } from './fixture.js'

const TENANT_A = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FA1')
const TENANT_B = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FA2')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FA1')
const TERMINATION_SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FA2')

describeWithDatabase('tenant-scoped PostgreSQL sessions', () => {
  afterEach(async () => {
    await database.query('delete from tenants where id = any($1::text[])', [[TENANT_A, TENANT_B]])
  })

  it('denies cross-tenant reads and resolves one of two conflicting CAS transitions', async () => {
    const tenants = new PostgresTenantRepository(database)
    const sessions = new PostgresSessionRepository(database)
    for (const [id, name] of [
      [TENANT_A, 'Tenant A'],
      [TENANT_B, 'Tenant B'],
    ] as const) {
      await tenants.insertTenant(
        TenantSchema.parse({
          id,
          name,
          status: 'active',
          plan: 'development',
          createdAt: '2026-08-08T00:00:00.000Z',
          updatedAt: '2026-08-08T00:00:00.000Z',
        }),
      )
    }
    await sessions.insertSession(
      SessionSchema.parse({
        id: SESSION_ID,
        tenantID: TENANT_B,
        status: 'pending',
        requestedCapabilities: { javascript: 'required' },
        selectedRuntime: null,
        selectedProvider: null,
        providerSessionReferenceEncrypted: null,
        routingDecisionID: null,
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
        connectedAt: null,
        expiresAt: null,
        terminatedAt: null,
        terminationReason: null,
        version: 0,
      }),
    )

    expect(await sessions.findSessionForTenant(TENANT_A, SESSION_ID)).toBeNull()
    const results = await Promise.allSettled([
      sessions.transitionSessionForTenant({
        tenantID: TENANT_B,
        sessionID: SESSION_ID,
        expectedVersion: 0,
        event: { type: 'begin_routing', at: '2026-08-08T00:00:01.000Z' },
      }),
      sessions.transitionSessionForTenant({
        tenantID: TENANT_B,
        sessionID: SESSION_ID,
        expectedVersion: 0,
        event: {
          type: 'fail',
          at: '2026-08-08T00:00:01.000Z',
          reason: 'concurrent_failure',
        },
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('keeps repeated termination requests idempotent after the terminal transition', async () => {
    const tenants = new PostgresTenantRepository(database)
    const sessions = new PostgresSessionRepository(database)
    await tenants.insertTenant(
      TenantSchema.parse({
        id: TENANT_B,
        name: 'Termination tenant',
        status: 'active',
        plan: 'development',
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
      }),
    )
    await sessions.insertSession(
      SessionSchema.parse({
        id: TERMINATION_SESSION_ID,
        tenantID: TENANT_B,
        status: 'active',
        requestedCapabilities: { javascript: 'required' },
        selectedRuntime: 'chromium',
        selectedProvider: 'cloudflare-browser-run',
        providerSessionReferenceEncrypted:
          'psr.v1.test.abcdefghijklmnop.ciphertext.AAAAAAAAAAAAAAAAAAAAAA',
        routingDecisionID: null,
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:01.000Z',
        connectedAt: '2026-08-08T00:00:01.000Z',
        expiresAt: '2026-08-08T00:05:00.000Z',
        terminatedAt: null,
        terminationReason: null,
        version: 0,
      }),
    )
    const terminating = await sessions.transitionSessionForTenant({
      tenantID: TENANT_B,
      sessionID: TERMINATION_SESSION_ID,
      expectedVersion: 0,
      event: { type: 'request_termination', at: '2026-08-08T00:00:02.000Z' },
    })
    const terminated = await sessions.transitionSessionForTenant({
      tenantID: TENANT_B,
      sessionID: TERMINATION_SESSION_ID,
      expectedVersion: terminating.version,
      event: {
        type: 'complete_termination',
        at: '2026-08-08T00:00:03.000Z',
        reason: 'client_requested',
      },
    })
    const repeated = await sessions.transitionSessionForTenant({
      tenantID: TENANT_B,
      sessionID: TERMINATION_SESSION_ID,
      expectedVersion: terminated.version,
      event: { type: 'request_termination', at: '2026-08-08T00:00:04.000Z' },
    })

    expect(repeated).toEqual(terminated)
    expect(repeated.status).toBe('terminated')
    expect(repeated.version).toBe(2)
  })

  it('executes the bounded reconciliation candidate query', async () => {
    const sessions = new PostgresSessionRepository(database)
    await expect(
      sessions.findReconciliationCandidates({ staleAfterMs: 60_000, batchSize: 10 }),
    ).resolves.toEqual(expect.any(Array))
  })
})
