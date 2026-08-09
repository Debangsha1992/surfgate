import { afterEach, expect, it } from 'vitest'

import { RoutingDecisionIDSchema, SessionIDSchema, TenantIDSchema } from '@surfgate/contracts'
import { ProviderIDSchema, RuntimeClassSchema } from '@surfgate/provider-core'
import { routeBrowserRuntime, RoutingInputSchema } from '@surfgate/router'

import { PostgresRoutingDecisionRepository } from '../../src/database/postgres-routing-decision-repository.js'
import { PostgresSessionRepository } from '../../src/database/postgres-session-repository.js'
import { PostgresTenantRepository } from '../../src/database/postgres-tenant-repository.js'
import { SessionSchema } from '../../src/domain/session.js'
import { TenantSchema } from '../../src/domain/tenant.js'
import { database, describeWithDatabase } from './fixture.js'

const TENANT_A = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FA3')
const TENANT_B = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FA4')
const SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FA4')
const OTHER_SESSION_ID = SessionIDSchema.parse('ses_01ARZ3NDEKTSV4RRFFQ69G5FA5')
const DECISION_ID = RoutingDecisionIDSchema.parse('rtd_01ARZ3NDEKTSV4RRFFQ69G5FA4')

const CAPABILITIES = {
  javascript: 'supported',
  dom: 'supported',
  xhr: 'supported',
  svg: 'supported',
  screenshot: 'supported',
  pdf: 'supported',
  webgl: 'supported',
  video: 'experimental',
  persistentAuth: 'supported',
  realBrowserTLS: 'supported',
  downloads: 'unknown',
  uploads: 'unknown',
  multiTab: 'supported',
  longSession: 'supported',
} as const

describeWithDatabase('tenant-scoped routing decisions', () => {
  afterEach(async () => {
    await database.query('delete from tenants where id = any($1::text[])', [[TENANT_A, TENANT_B]])
  })

  it('persists the complete router model and denies cross-tenant reads', async () => {
    const tenants = new PostgresTenantRepository(database)
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
    await new PostgresSessionRepository(database).insertSession(
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
    const decision = routeBrowserRuntime(
      RoutingInputSchema.parse({
        decisionID: DECISION_ID,
        tenantID: TENANT_B,
        requestID: 'req_01ARZ3NDEKTSV4RRFFQ69G5FA4',
        createdAt: '2026-08-08T00:00:01.000Z',
        capabilityRegistryVersion: 'cap-v1',
        requirements: { javascript: 'required' },
        runtime: { preference: 'auto', allowFallback: true, allowExperimental: false },
        maxSessionDurationMs: 60_000,
        candidateSources: [
          {
            descriptor: {
              providerID: 'cloudflare-browser-run',
              runtimeClass: 'chromium',
              displayName: 'Cloudflare Browser Run Chromium',
              capabilities: CAPABILITIES,
              implementation: { name: '@surfgate/provider-chromium', version: 'test' },
              configured: true,
            },
            health: {
              status: 'healthy',
              configured: true,
              diagnosticCode: 'PROVIDER_HEALTHY',
              capacity: 'unknown',
              checkedAt: '2026-08-08T00:00:01.000Z',
            },
          },
        ],
      }),
    )
    const decisions = new PostgresRoutingDecisionRepository(database)

    await expect(
      decisions.saveRoutingDecisionForTenant({
        tenantID: TENANT_B,
        sessionID: SESSION_ID,
        decision,
      }),
    ).resolves.toEqual(decision)
    await expect(decisions.findRoutingDecisionForTenant(TENANT_B, DECISION_ID)).resolves.toEqual(
      decision,
    )
    await expect(decisions.findRoutingDecisionForTenant(TENANT_A, DECISION_ID)).resolves.toBeNull()

    await new PostgresSessionRepository(database).insertSession(
      SessionSchema.parse({
        id: OTHER_SESSION_ID,
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
    const sessions = new PostgresSessionRepository(database)
    const routing = await sessions.transitionSessionForTenant({
      tenantID: TENANT_B,
      sessionID: OTHER_SESSION_ID,
      expectedVersion: 0,
      event: { type: 'begin_routing', at: '2026-08-08T00:00:01.000Z' },
    })
    await expect(
      sessions.transitionSessionForTenant({
        tenantID: TENANT_B,
        sessionID: OTHER_SESSION_ID,
        expectedVersion: routing.version,
        event: {
          type: 'begin_allocation',
          at: '2026-08-08T00:00:02.000Z',
          selectedRuntime: RuntimeClassSchema.parse('chromium'),
          selectedProvider: ProviderIDSchema.parse('cloudflare-browser-run'),
          routingDecisionID: DECISION_ID,
        },
      }),
    ).rejects.toThrow()
  })
})
