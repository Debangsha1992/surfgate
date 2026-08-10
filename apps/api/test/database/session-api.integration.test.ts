import { afterEach, beforeEach, expect, it } from 'vitest'

import { parseConfig } from '@surfgate/config'
import {
  APIKeyIDSchema,
  SessionCreateResponseSchema,
  SessionTerminationResponseSchema,
  TenantIDSchema,
} from '@surfgate/contracts'
import { ProviderDescriptorSchema } from '@surfgate/provider-core'
import {
  FakeBrowserProvider,
  createFakeProviderConfig,
  createFakeProviderDescriptor,
} from '@surfgate/testing'

import { buildAPIApplication } from '../../src/app.js'
import { issueAPIKey } from '../../src/auth/api-key.js'
import { createAPIKeyAuthenticator } from '../../src/auth/authentication.js'
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
import { database, describeWithDatabase } from './fixture.js'

const TENANT_A = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FD1')
const TENANT_B = TenantIDSchema.parse('ten_01ARZ3NDEKTSV4RRFFQ69G5FD2')

const config = parseConfig({
  NODE_ENV: 'test',
  SURFGATE_RELAY_PUBLIC_URL: 'ws://127.0.0.1:8081',
  DATABASE_URL: 'postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate',
  REDIS_URL: 'redis://127.0.0.1:6379',
  S3_REGION: 'auto',
  S3_BUCKET: 'surfgate-test',
  SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
})

function fake(runtimeClass: 'kitesurf' | 'chromium') {
  const descriptor = createFakeProviderDescriptor()
  return new FakeBrowserProvider(
    createFakeProviderConfig({
      descriptor: ProviderDescriptorSchema.parse({
        ...descriptor,
        runtimeClass,
        configProfile: runtimeClass,
      }),
      nowEpochMs: Date.now(),
    }),
  )
}

describeWithDatabase('authenticated session API integration', () => {
  beforeEach(async () =>
    database.query('delete from tenants where id = any($1::text[])', [[TENANT_A, TENANT_B]]),
  )
  afterEach(async () =>
    database.query('delete from tenants where id = any($1::text[])', [[TENANT_A, TENANT_B]]),
  )

  it('creates, reads, isolates, and idempotently terminates a fake-provider session', async () => {
    const tenants = new PostgresTenantRepository(database)
    for (const [id, name] of [
      [TENANT_A, 'A'],
      [TENANT_B, 'B'],
    ] as const) {
      await tenants.insertTenant(
        TenantSchema.parse({
          id,
          name,
          status: 'active',
          plan: 'development',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      )
    }
    const keys = new PostgresAPIKeyRepository(database)
    const issuedA = await issueAPIKey({
      id: APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FD1'),
      tenantID: TENANT_A,
      mode: 'test',
      scopes: ['sessions:write', 'sessions:read', 'sessions:terminate'],
      now: new Date(),
    })
    const issuedB = await issueAPIKey({
      id: APIKeyIDSchema.parse('key_01ARZ3NDEKTSV4RRFFQ69G5FD2'),
      tenantID: TENANT_B,
      mode: 'test',
      scopes: ['sessions:write', 'sessions:read', 'sessions:terminate', 'sessions:connect'],
      now: new Date(),
    })
    await keys.insertAPIKey(issuedA.metadata)
    await keys.insertAPIKey(issuedB.metadata)
    const redis = createRedisRateLimitStore(config.redis)
    const service = new SessionService({
      sessions: new PostgresSessionRepository(database),
      decisions: new PostgresRoutingDecisionRepository(database),
      attempts: new PostgresAllocationAttemptRepository(database),
      audit: new PostgresAuditEventRepository(database),
      coordinator: new PostgresSessionCreateCoordinator(database),
      rateLimiter: createRequestRateLimiter(redis),
      targetPolicy: { validate: (value) => Promise.resolve(value) },
      registry: new ProviderRegistry([fake('kitesurf'), fake('chromium')]),
      protector: createProviderSessionReferenceProtector(
        config.security.providerSessionEncryption!,
      ),
      config: config.controlPlane,
    })
    const app = buildAPIApplication({
      databaseHealth: database,
      redisHealth: redis,
      logger: false,
      authenticate: createAPIKeyAuthenticator({ apiKeys: keys, tenants }),
      sessionService: service,
    })
    try {
      const headersA = {
        authorization: `Bearer ${issuedA.plaintext}`,
        'idempotency-key': 'api-integration-1',
      }
      const [created, concurrent] = await Promise.all([
        app.inject({ method: 'POST', url: '/v1/sessions', headers: headersA, payload: {} }),
        app.inject({ method: 'POST', url: '/v1/sessions', headers: headersA, payload: {} }),
      ])
      expect(created.statusCode).toBe(201)
      const createdBody = SessionCreateResponseSchema.parse(created.json())
      const sessionID = createdBody.session.id
      expect(SessionCreateResponseSchema.parse(concurrent.json()).session.id).toBe(sessionID)
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: headersA,
        payload: {},
      })
      expect(replay.statusCode).toBe(201)
      expect(SessionCreateResponseSchema.parse(replay.json()).session.id).toBe(sessionID)
      const conflict = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: headersA,
        payload: { maxDurationSeconds: 300 },
      })
      expect(conflict.statusCode).toBe(409)
      expect(conflict.json()).toMatchObject({
        error: { code: 'VALIDATION_IDEMPOTENCY_CONFLICT' },
      })
      const hidden = await app.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionID}`,
        headers: { authorization: `Bearer ${issuedB.plaintext}` },
      })
      expect(hidden.statusCode).toBe(404)
      const hiddenTermination = await app.inject({
        method: 'DELETE',
        url: `/v1/sessions/${sessionID}`,
        headers: { authorization: `Bearer ${issuedB.plaintext}` },
      })
      const hiddenRelayToken = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionID}/relay-token`,
        headers: { authorization: `Bearer ${issuedB.plaintext}` },
      })
      expect(hiddenTermination.statusCode).toBe(404)
      expect(hiddenRelayToken.statusCode).toBe(404)

      const tenantBIndependentCreate = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: {
          authorization: `Bearer ${issuedB.plaintext}`,
          'idempotency-key': 'api-integration-1',
        },
        payload: {},
      })
      expect(tenantBIndependentCreate.statusCode).toBe(201)
      expect(
        SessionCreateResponseSchema.parse(tenantBIndependentCreate.json()).session.id,
      ).not.toBe(sessionID)
      const terminated = await app.inject({
        method: 'DELETE',
        url: `/v1/sessions/${sessionID}`,
        headers: { authorization: `Bearer ${issuedA.plaintext}` },
      })
      const repeated = await app.inject({
        method: 'DELETE',
        url: `/v1/sessions/${sessionID}`,
        headers: { authorization: `Bearer ${issuedA.plaintext}` },
      })
      expect(terminated.statusCode).toBe(200)
      expect(SessionTerminationResponseSchema.parse(repeated.json()).session.status).toBe(
        'terminated',
      )
      expect(`${created.body}${terminated.body}`).not.toContain('psr.v1')
    } finally {
      await app.close()
      await redis.close()
    }
  })
})
