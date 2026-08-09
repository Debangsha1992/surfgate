import { fileURLToPath } from 'node:url'

import { loadConfig } from '@surfgate/config'
import { APIKeyIDSchema, SessionCreateResponseSchema, TenantIDSchema } from '@surfgate/contracts'
import { createChromiumBrowserProvider } from '@surfgate/provider-chromium'
import { createKitesurfBrowserProvider } from '@surfgate/provider-kitesurf'
import { describe, expect, it } from 'vitest'

import { buildAPIApplication } from '../../src/app.js'
import { issueAPIKey } from '../../src/auth/api-key.js'
import { createAPIKeyAuthenticator } from '../../src/auth/authentication.js'
import { assertTestDatabaseURL, createDatabase } from '../../src/database/database.js'
import { runMigrations } from '../../src/database/migrate.js'
import { PostgresAllocationAttemptRepository } from '../../src/database/postgres-allocation-attempt-repository.js'
import { PostgresAPIKeyRepository } from '../../src/database/postgres-api-key-repository.js'
import { PostgresAuditEventRepository } from '../../src/database/postgres-audit-event-repository.js'
import { PostgresRoutingDecisionRepository } from '../../src/database/postgres-routing-decision-repository.js'
import { PostgresSessionCreateCoordinator } from '../../src/database/postgres-session-create-coordinator.js'
import { PostgresSessionRepository } from '../../src/database/postgres-session-repository.js'
import { PostgresTenantRepository } from '../../src/database/postgres-tenant-repository.js'
import { TenantSchema } from '../../src/domain/tenant.js'
import { ProviderRegistry } from '../../src/providers/provider-registry.js'
import { createRequestRateLimiter } from '../../src/quota/rate-limiter.js'
import { createRedisRateLimitStore } from '../../src/redis/redis-client.js'
import { createProviderSessionReferenceProtector } from '../../src/security/provider-session-reference.js'
import { SessionService } from '../../src/services/session-service.js'

const config = loadConfig()
const canRun =
  config.cloudflare.credentials !== undefined &&
  config.database.testURL !== undefined &&
  config.security.providerSessionEncryption !== undefined
const liveTest = canRun ? it : it.skip
const TENANT_ID = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FE1')

describe('live authenticated session control plane', () => {
  liveTest(
    'allocates through routing and terminates through the public API',
    async () => {
      const testURL = config.database.testURL!
      assertTestDatabaseURL(testURL)
      const database = createDatabase({ url: testURL })
      const redis = createRedisRateLimitStore(config.redis)
      let app: ReturnType<typeof buildAPIApplication> | undefined
      try {
        await runMigrations(database, fileURLToPath(new URL('../../migrations/', import.meta.url)))
        await database.query('delete from tenants where id = $1', [TENANT_ID])
        const tenants = new PostgresTenantRepository(database)
        const keys = new PostgresAPIKeyRepository(database)
        const now = new Date()
        await tenants.insertTenant(
          TenantSchema.parse({
            id: TENANT_ID,
            name: 'Live smoke tenant',
            status: 'active',
            plan: 'live-smoke',
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          }),
        )
        const issued = await issueAPIKey({
          id: APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FE1'),
          tenantID: TENANT_ID,
          mode: 'test',
          scopes: ['sessions:write', 'sessions:terminate'],
          now,
        })
        await keys.insertAPIKey(issued.metadata)
        const service = new SessionService({
          sessions: new PostgresSessionRepository(database),
          decisions: new PostgresRoutingDecisionRepository(database),
          attempts: new PostgresAllocationAttemptRepository(database),
          audit: new PostgresAuditEventRepository(database),
          coordinator: new PostgresSessionCreateCoordinator(database),
          rateLimiter: createRequestRateLimiter(redis),
          targetPolicy: { validate: (value) => Promise.resolve(value) },
          registry: new ProviderRegistry([
            createKitesurfBrowserProvider(config.cloudflare),
            createChromiumBrowserProvider(config.cloudflare),
          ]),
          protector: createProviderSessionReferenceProtector(
            config.security.providerSessionEncryption!,
          ),
          config: config.controlPlane,
        })
        app = buildAPIApplication({
          databaseHealth: database,
          redisHealth: redis,
          logger: false,
          authenticate: createAPIKeyAuthenticator({ apiKeys: keys, tenants }),
          sessionService: service,
        })
        const authorization = `Bearer ${issued.plaintext}`
        const created = await app.inject({
          method: 'POST',
          url: '/v1/sessions',
          headers: { authorization, 'idempotency-key': `live-${Date.now()}` },
          payload: {},
        })
        expect(created.statusCode).toBe(201)
        const session = SessionCreateResponseSchema.parse(created.json()).session
        expect(session.status).toBe('active')
        const terminated = await app.inject({
          method: 'DELETE',
          url: `/v1/sessions/${session.id}`,
          headers: { authorization },
        })
        expect(terminated.statusCode).toBe(200)
        expect(terminated.json()).toMatchObject({ session: { status: 'terminated' } })
      } finally {
        if (app !== undefined) await app.close()
        await redis.close()
        await database
          .query('delete from tenants where id = $1', [TENANT_ID])
          .catch(() => undefined)
        await database.close()
      }
    },
    120_000,
  )
})
