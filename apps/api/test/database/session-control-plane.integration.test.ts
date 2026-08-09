import { afterEach, beforeEach, expect, it } from 'vitest'

import {
  RequestIDSchema,
  SessionIDSchema,
  TenantIDSchema,
  type SessionID,
} from '@surfgate/contracts'

import { PostgresAuditEventRepository } from '../../src/database/postgres-audit-event-repository.js'
import { PostgresSessionCreateCoordinator } from '../../src/database/postgres-session-create-coordinator.js'
import { PostgresTenantRepository } from '../../src/database/postgres-tenant-repository.js'
import { SessionSchema } from '../../src/domain/session.js'
import { TenantSchema } from '../../src/domain/tenant.js'
import { database, describeWithDatabase } from './fixture.js'

const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FB1')
const SESSION_A = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FB1')
const SESSION_B = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FB2')

function session(id: SessionID) {
  return SessionSchema.parse({
    id,
    tenantID: TENANT_ID,
    status: 'pending',
    requestedCapabilities: {},
    selectedRuntime: null,
    selectedProvider: null,
    providerSessionReferenceEncrypted: null,
    routingDecisionID: null,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    connectedAt: null,
    expiresAt: null,
    terminatedAt: null,
    terminationReason: null,
    version: 0,
  })
}

describeWithDatabase('durable idempotency, quota reservation, and audit', () => {
  beforeEach(async () => {
    await database.query('delete from tenants where id = $1', [TENANT_ID])
  })
  afterEach(async () => {
    await database.query('delete from tenants where id = $1', [TENANT_ID])
  })

  it('allows one owner for simultaneous duplicate claims and detects body conflict', async () => {
    await new PostgresTenantRepository(database).insertTenant(
      TenantSchema.parse({
        id: TENANT_ID,
        name: 'Control Plane',
        status: 'active',
        plan: 'development',
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      }),
    )
    const coordinator = new PostgresSessionCreateCoordinator(database)
    const base = {
      tenantID: TENANT_ID,
      key: 'same-key',
      requestHash: 'a'.repeat(64),
      ownerToken: 'A'.repeat(32),
      leaseExpiresAt: '2026-08-09T00:01:00.000Z',
      maxConcurrentSessions: 2,
    }
    const claims = await Promise.all([
      coordinator.claim({ ...base, session: session(SESSION_A) }),
      coordinator.claim({ ...base, ownerToken: 'B'.repeat(32), session: session(SESSION_B) }),
    ])
    expect(claims.filter((claim) => claim.kind === 'owner')).toHaveLength(1)
    expect(claims.filter((claim) => claim.kind === 'existing')).toHaveLength(1)
    await expect(
      coordinator.claim({
        ...base,
        requestHash: 'b'.repeat(64),
        ownerToken: 'C'.repeat(32),
        session: session(SESSION_B),
      }),
    ).resolves.toEqual({ kind: 'conflict' })
  })

  it('stores immutable secret-free audit events', async () => {
    await new PostgresTenantRepository(database).insertTenant(
      TenantSchema.parse({
        id: TENANT_ID,
        name: 'Audit Tenant',
        status: 'active',
        plan: 'development',
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
      }),
    )
    await new PostgresAuditEventRepository(database).append({
      tenantID: TENANT_ID,
      type: 'quota.denied',
      requestID: RequestIDSchema.parse('req_01ARZ3NDEKTSV4RRFFQ69G5FB1'),
      metadata: { reason: 'rate_limit' },
      createdAt: '2026-08-09T00:00:00.000Z',
    })
    await expect(
      database.query('update audit_events set metadata = $1::jsonb where tenant_id = $2', [
        '{}',
        TENANT_ID,
      ]),
    ).rejects.toThrow()
  })
})
