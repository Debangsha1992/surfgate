# SurfGate Control Plane Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver SG-0501 through SG-0503: a production-oriented Fastify skeleton, tenant-scoped API-key authentication, and concurrency-safe PostgreSQL persistence for tenants, API keys, sessions, and routing decisions.

**Architecture:** `apps/api` owns HTTP orchestration and a dedicated SQL-first data-access layer built on one PostgreSQL client. Public health/error shapes stay in `packages/contracts`, environment parsing stays in `packages/config`, routing decisions remain owned by the database-independent router, and encrypted provider session references never cross the persistence boundary unprotected.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9 strict mode, Fastify, PostgreSQL via `pg`, committed SQL migrations, Zod 4, Node `crypto` scrypt and AES-256-GCM, Vitest, pnpm/Turbo.

## Global Constraints

- Scope only SG-0501, SG-0502, and SG-0503; do not add production session CRUD/allocation routes.
- Do not read `process.env` outside `packages/config`.
- Do not expose API-key secrets, key hashes, database URLs, provider references, SQL, or stack traces.
- Every repository resource read is tenant-scoped; no public `getSession(id)` or `getRoutingDecision(id)` API.
- Session updates use PostgreSQL compare-and-set semantics; process-local locking is not a correctness mechanism.
- Migrations are committed, deterministic, checksum-verified, and executed separately from API startup.
- Provider session references use AES-256-GCM with an externally supplied 32-byte key and tenant/session-bound associated data.
- Tests must reject non-test database URLs before destructive integration-test cleanup.
- Preserve router/provider boundaries and do not add Redis to this milestone.

---

### Task 1: Contract and configuration boundaries

**Files:**

- Create: `packages/contracts/src/control-plane.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/config/src/types.ts`
- Modify: `packages/config/src/validation.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `.env.example`
- Test: `packages/contracts/test/control-plane.test.ts`
- Test: `packages/config/test/config.test.ts`

**Interfaces:**

- Produces: `LivenessResponseSchema`, `ReadinessResponseSchema`, `ProviderSessionEncryptionConfig`.
- Consumes: existing opaque request IDs and canonical SurfGate error responses.

- [x] **Step 1: Write failing contract/config tests**

```ts
expect(LivenessResponseSchema.parse({ status: 'alive' })).toEqual({ status: 'alive' })
expect(
  ReadinessResponseSchema.safeParse({ status: 'ready', dependencies: { postgres: 'ready' } })
    .success,
).toBe(true)
expect(
  parseConfig({
    ...VALID_DEVELOPMENT_ENVIRONMENT,
    SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY: validBase64Key,
  }).security.providerSessionEncryption.key,
).toHaveLength(32)
```

- [x] **Step 2: Run the focused tests and confirm missing exports fail**

Run: `pnpm --filter @surfgate/contracts test && pnpm --filter @surfgate/config test`

Expected: FAIL because the control-plane schemas and encryption config do not exist.

- [x] **Step 3: Add strict health schemas and sanitized error codes**

```ts
export const LivenessResponseSchema = z
  .object({ status: z.literal('alive') })
  .strict()
  .readonly()
export const ReadinessResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    dependencies: z
      .object({ postgres: z.enum(['ready', 'unavailable']) })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly()
```

Add stable `SESSION_INVALID_TRANSITION` and `INTERNAL_DATABASE_UNAVAILABLE` canonical errors. Parse `SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY` as exactly 32 decoded bytes and optional `SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY_ID` as a non-secret identifier; require the key in production and permit it to be absent only when encrypted persistence is not constructed.

- [x] **Step 4: Run focused tests until green**

Run: `pnpm --filter @surfgate/contracts test && pnpm --filter @surfgate/config test`

Expected: PASS.

### Task 2: PostgreSQL migrations and pool lifecycle

**Files:**

- Create: `docs/adr/0009-sql-first-postgresql-control-plane.md`
- Create: `apps/api/migrations/0001-control-plane.sql`
- Create: `apps/api/migrations/0002-control-plane-invariants.sql`
- Create: `apps/api/migrations/0003-bind-routing-decisions-to-sessions.sql`
- Create: `apps/api/src/database/database.ts`
- Create: `apps/api/src/database/migrate.ts`
- Create: `apps/api/test/database/migrate.integration.test.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `turbo.json`

**Interfaces:**

- Produces: `createDatabase(config)`, `Database.close()`, `Database.health()`, `Database.transaction(callback)`, `runMigrations(database, directory)`.
- Consumes: `SurfGateConfig.database.url` only; no direct environment access.

- [x] **Step 1: Add a failing migration integration test**

```ts
await runMigrations(database, migrationsDirectory)
expect(
  await database.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' and table_name = $1`,
    ['sessions'],
  ),
).toHaveLength(1)
```

The test must call `assertTestDatabaseURL(url)` before cleanup and reject database names not ending in `_test`.

- [x] **Step 2: Run the isolated integration test and confirm it fails before implementation**

Run: `pnpm --filter @surfgate/api test:integration -- migrate`

Expected: FAIL because the database/migration modules do not exist (or cleanly skip only when the explicitly gated test database is unavailable).

- [x] **Step 3: Implement one SQL-first data layer and committed migration**

```ts
export interface Queryable {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]>
}

export interface Database extends Queryable {
  health(): Promise<'ready' | 'unavailable'>
  transaction<Result>(operation: (transaction: Queryable) => Promise<Result>): Promise<Result>
  close(): Promise<void>
}
```

The migration creates `tenants`, `api_keys`, `sessions`, `routing_decisions`, schema constraints/indexes, a `version` column for session CAS, and a migration ledger with SHA-256 checksums. The runner uses a transaction and PostgreSQL advisory lock; API startup never invokes it.

- [x] **Step 4: Document the SQL-first decision**

Record why `pg` plus explicit SQL migrations was selected over adding an ORM: predictable SQL, transactions, low hidden behavior, and Zod validation at row boundaries.

- [x] **Step 5: Run migration tests**

Run: `pnpm --filter @surfgate/api test:integration -- migrate`

Expected: PASS with a dedicated `_test` database.

### Task 3: Tenant and API-key domain/authentication

**Files:**

- Create: `apps/api/src/auth/api-key.ts`
- Create: `apps/api/src/auth/authentication.ts`
- Create: `apps/api/src/auth/context.ts`
- Create: `apps/api/src/domain/tenant.ts`
- Create: `apps/api/src/repositories/tenant-repository.ts`
- Create: `apps/api/src/repositories/api-key-repository.ts`
- Create: `apps/api/src/database/postgres-tenant-repository.ts`
- Create: `apps/api/src/database/postgres-api-key-repository.ts`
- Test: `apps/api/test/auth/api-key.test.ts`
- Test: `apps/api/test/auth/authentication.test.ts`
- Test: `apps/api/test/database/authentication.integration.test.ts`

**Interfaces:**

- Produces: `issueAPIKey()`, `verifyAPIKeySecret()`, `authenticateBearer()`, `AuthenticatedTenantContext`, `TenantRepository`, `APIKeyRepository`.
- Consumes: opaque tenant/API-key IDs and an injected repository; returns a secret only from issuance.

- [x] **Step 1: Write failing secret lifecycle and auth tests**

```ts
const issued = await issueAPIKey({ apiKeyID, tenantID, scopes: ['sessions:read'], mode: 'live' })
expect(issued.plaintext).toMatch(/^sg_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/u)
expect(issued.metadata.keyHash).not.toContain(issued.plaintext)
expect(await verifyAPIKeySecret(issued.plaintext, issued.metadata)).toBe(true)
expect(JSON.stringify(issued.metadata)).not.toContain(issued.secret)
```

Cover valid, missing, malformed, wrong, revoked, expired, and forbidden-scope cases. Missing/prefix-miss/wrong-secret responses must share the canonical external `AUTH_INVALID_CREDENTIALS` message.

- [x] **Step 2: Run auth tests and observe the expected missing-module failures**

Run: `pnpm --filter @surfgate/api test -- auth`

Expected: FAIL.

- [x] **Step 3: Implement high-entropy key generation and scrypt verification**

```ts
export type APIKeyMetadata = Readonly<{
  id: APIKeyID
  tenantID: TenantID
  keyPrefix: string
  keyHash: string
  scopes: readonly APIKeyScope[]
  createdAt: string
  expiresAt?: string
  revokedAt?: string
}>
```

Use 32 random secret bytes, a 12-hex-character lookup prefix, per-key 16-byte salt, versioned scrypt parameters, bounded parser validation, and `timingSafeEqual`. Always perform a dummy scrypt verification for an unknown prefix. Never log or serialize plaintext/hash data through public metadata.

- [x] **Step 4: Implement repository-backed tenant context**

```ts
export type AuthenticatedTenantContext = Readonly<{
  tenantID: TenantID
  apiKeyID: APIKeyID
  scopes: readonly APIKeyScope[]
  requestID: RequestID
}>
```

Reject inactive tenants and establish this context only after credential, expiry, revocation, and scope checks.

- [x] **Step 5: Run auth unit and PostgreSQL integration tests**

Run: `pnpm --filter @surfgate/api test -- auth && pnpm --filter @surfgate/api test:integration -- authentication`

Expected: PASS.

### Task 4: Session domain state machine and encrypted provider reference

**Files:**

- Create: `apps/api/src/domain/session.ts`
- Create: `apps/api/src/security/provider-session-reference.ts`
- Test: `apps/api/test/domain/session.test.ts`
- Test: `apps/api/test/security/provider-session-reference.test.ts`

**Interfaces:**

- Produces: `SessionSchema`, `SessionStatusSchema`, `applySessionTransition(session, event)`, `ProviderSessionReferenceProtector.encrypt/decrypt`.
- Consumes: capability requirements, provider-neutral selected runtime/provider metadata, opaque IDs, and validated UTC timestamps.

- [x] **Step 1: Write failing state-machine/encryption tests**

```ts
expect(applySessionTransition(pending, { type: 'begin_routing', at })).toMatchObject({
  status: 'routing',
})
expect(() => applySessionTransition(terminated, { type: 'activate', at })).toThrow(
  SessionTransitionError,
)
expect(applySessionTransition(terminated, { type: 'request_termination', at })).toBe(terminated)
expect(await protector.decrypt(await protector.encrypt(reference, context), context)).toEqual(
  reference,
)
```

Also prove ciphertext differs for repeated encryption, associated-data mismatch fails closed, and secrets never appear in ciphertext/error strings.

- [x] **Step 2: Run focused tests and confirm they fail**

Run: `pnpm --filter @surfgate/api test -- session provider-session-reference`

Expected: FAIL.

- [x] **Step 3: Implement the explicit reducer and AES-GCM envelope**

Use events `begin_routing`, `begin_allocation`, `begin_fallback_allocation`, `activate`, `request_termination`, `complete_termination`, `expire`, and `fail`. Terminal states (`terminated`, `expired`, `failed`) cannot reactivate; termination requests against a terminal/terminating session are idempotent. AES-256-GCM uses a random 96-bit IV, 128-bit tag, version/key ID, and AAD `${tenantID}\0${sessionID}`.

- [x] **Step 4: Run focused tests until green**

Run: `pnpm --filter @surfgate/api test -- session provider-session-reference`

Expected: PASS.

### Task 5: Tenant-scoped session and routing-decision repositories

**Files:**

- Create: `apps/api/src/repositories/session-repository.ts`
- Create: `apps/api/src/repositories/routing-decision-repository.ts`
- Create: `apps/api/src/database/postgres-session-repository.ts`
- Create: `apps/api/src/database/postgres-routing-decision-repository.ts`
- Test: `apps/api/test/database/session-repository.integration.test.ts`
- Test: `apps/api/test/database/routing-decision-repository.integration.test.ts`

**Interfaces:**

- Produces: `findSessionForTenant(tenantID, sessionID)`, `transitionSessionForTenant(input)`, `findRoutingDecisionForTenant(tenantID, decisionID)`, `saveRoutingDecisionForTenant(input)`.
- Consumes: `RoutingDecisionSchema`; never duplicates router scoring or reason semantics.

- [x] **Step 1: Write failing cross-tenant and CAS tests**

```ts
expect(await sessions.findSessionForTenant(tenantA, sessionOwnedByB)).toBeNull()
const results = await Promise.allSettled([
  sessions.transitionSessionForTenant({
    tenantID,
    sessionID,
    expectedVersion: 0,
    event: terminate,
  }),
  sessions.transitionSessionForTenant({ tenantID, sessionID, expectedVersion: 0, event: expire }),
])
expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
expect(await decisions.findRoutingDecisionForTenant(tenantA, tenantBDecisionID)).toBeNull()
```

- [x] **Step 2: Run repository integration tests and observe failures**

Run: `pnpm --filter @surfgate/api test:integration -- repository`

Expected: FAIL.

- [x] **Step 3: Implement tenant-scoped SQL and row validation**

All reads use both `tenant_id` and resource ID. State updates use `UPDATE ... WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = $4 RETURNING ...`; zero updated rows are resolved as not-found, idempotent terminal state, or a stable transition conflict after a scoped reread. Routing decisions store the complete validated router JSON plus extracted indexed correlation/version columns.

- [x] **Step 4: Run integration tests until green**

Run: `pnpm --filter @surfgate/api test:integration -- repository`

Expected: PASS.

### Task 6: Fastify bootstrap, health, error boundary, telemetry, and graceful lifecycle

**Files:**

- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/errors/http-error.ts`
- Create: `apps/api/src/http/request-id.ts`
- Create: `apps/api/src/http/authentication-hook.ts`
- Create: `apps/api/src/http/health-routes.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/main.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `packages/observability/src/index.ts`
- Test: `apps/api/test/app.test.ts`
- Test: `apps/api/test/auth/authentication-hook.test.ts`
- Test: `apps/api/test/server.test.ts`

**Interfaces:**

- Produces: `buildAPIApplication(dependencies)`, `createAPIServer(config)`, `APIServer.start()`, `APIServer.close()`.
- Consumes: config, database health, auth service, and an injected structured telemetry sink.

- [x] **Step 1: Write failing injection tests**

```ts
expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503)
expect(JSON.stringify(await protectedResponse.json())).not.toContain(apiKeySecret)
```

Cover validated/propagated request IDs, generated IDs for invalid inbound values, readiness dependency failure, missing auth, malformed payload normalization, 404, unexpected error sanitization, secret-redacted logs, startup/close idempotency, and no production session endpoints.

- [x] **Step 2: Run Fastify tests and confirm failure**

Run: `pnpm --filter @surfgate/api test -- app authentication-hook server`

Expected: FAIL.

- [x] **Step 3: Implement the application boundary**

Use Fastify's finite request lifecycle with `genReqId`, `onRequest`/`onResponse` timing hooks, strict redaction of Authorization/Cookie/header fields, centralized canonical SurfGate error responses, `/health/live`, and `/health/ready`. Readiness checks PostgreSQL only; provider outages do not affect process liveness. `main.ts` owns SIGINT/SIGTERM handling and closes Fastify before the database pool.

- [x] **Step 4: Add framework-neutral observability ports**

```ts
export interface ControlPlaneTelemetry {
  recordHTTP(
    input: Readonly<{ method: string; route: string; statusCode: number; durationMs: number }>,
  ): void
  recordAuthentication(input: Readonly<{ outcome: 'success' | 'failure'; reason: string }>): void
  recordDatabaseHealth(status: 'ready' | 'unavailable'): void
  recordSessionTransition(
    input: Readonly<{ from: string; to: string; outcome: 'success' | 'conflict' }>,
  ): void
}
```

Request/session/API-key IDs never become metric labels. Structured logs may contain approved correlation IDs but never secrets.

- [x] **Step 5: Run API unit tests until green**

Run: `pnpm --filter @surfgate/api test`

Expected: PASS.

### Task 7: Documentation, regression, and security review

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/API.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/IMPLEMENTATION_PLAN.md`
- Modify: `docs/LOCAL_DEVELOPMENT.md`
- Modify: `apps/api/README.md`

**Interfaces:**

- Produces: operator/developer instructions for migrations, test DB isolation, key issuance, liveness/readiness, encryption key management, state transitions, and tenant scoping.

- [x] **Step 1: Update sources of truth**

Document `pnpm --filter @surfgate/api db:migrate`, the dedicated `_test` database requirement, liveness versus readiness, API-key one-time display/scrypt format, session transition table, tenant-scoped repository APIs, encrypted provider reference envelope, and production KMS/key-rotation follow-up.

- [x] **Step 2: Run focused security searches**

Run: `rg -n 'process\.env|Authorization|keyHash|providerSessionReference|SELECT|UPDATE' apps/api/src packages/contracts/src packages/config/src`

Expected: no `process.env` in the API, no raw secret logging/serialization, and every session/decision lookup visibly tenant-scoped.

- [x] **Step 3: Run formatter, lint, types, unit/build gate**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check`

Expected: PASS.

- [x] **Step 4: Run database and milestone regressions**

Run: `pnpm --filter @surfgate/api test:integration && pnpm --filter @surfgate/router test && pnpm --filter @surfgate/testing test:conformance && pnpm --filter @surfgate/provider-kitesurf test:conformance && pnpm --filter @surfgate/provider-chromium test:conformance`

Expected: PASS.

- [x] **Step 5: Review the complete diff**

Confirm no plaintext keys, unscoped resource lookup, terminal reactivation, direct environment read, provider allocation route, Redis coupling, router/database dependency, `any`, or unrelated change. Run an independent code/security review and fix all P0/P1 findings before completion.
