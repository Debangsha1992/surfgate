# SurfGate Session Control Plane Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task and verification-before-completion before reporting success.

**Goal:** Complete SG-0504 through SG-0507 with authenticated, tenant-scoped session lifecycle endpoints, durable idempotency and quotas, deterministic routing, bounded provider fallback, protected persistence, audit/telemetry, and schema-derived OpenAPI.

**Architecture:** Keep Fastify handlers thin and place orchestration in an application `SessionService`. PostgreSQL remains the durable source of truth for sessions, routing decisions, idempotency, allocation attempts, quotas, and audit records; Redis supplies a fail-closed distributed request-rate limiter. Providers are injected behind a provider-neutral registry, while `packages/router` remains pure and performs all selection and fallback classification.

**Tech Stack:** Node.js 24, TypeScript, Fastify 5, Zod 4, PostgreSQL/`pg`, Redis/`node-redis`, Vitest, pnpm/Turbo.

---

## Task 1: Add public v1 session contracts and stable errors

**Files:**

- Create: `packages/contracts/src/sessions.ts`
- Modify: `packages/contracts/src/control-plane.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/sessions.test.ts`

- [ ] Write failing schema tests for create requests, public-safe session responses, termination responses, idempotency headers, invalid capabilities, metadata bounds, and secret-field rejection.
- [ ] Add only the stable error codes needed for idempotency, quota, provider allocation, dependency failure, and session lifecycle responses.
- [ ] Implement strict runtime schemas and derive TypeScript types from them.
- [ ] Run `pnpm --filter @surfgate/contracts test` and confirm green.

## Task 2: Add quota/orchestration configuration

**Files:**

- Modify: `packages/config/src/types.ts`
- Modify: `packages/config/src/validation.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/test/config.test.ts`
- Modify: `.env.example`

- [ ] Write failing validation tests for default and malformed quota, timeout, and idempotency settings.
- [ ] Add validated control-plane quota and timeout configuration with deterministic defaults.
- [ ] Require provider-session encryption whenever session allocation can run; retain production fail-closed behavior.
- [ ] Run `pnpm --filter @surfgate/config test` and confirm green.

## Task 3: Add narrow target URL policy

**Files:**

- Create: `packages/security/src/target-policy.ts`
- Modify: `packages/security/src/index.ts`
- Modify: `packages/security/package.json`
- Create: `packages/security/test/target-policy.test.ts`

- [ ] Write failing tests for allowed public HTTP(S), blocked schemes, credentials, loopback/private/link-local/metadata addresses, internal suffixes, mixed DNS answers, DNS timeout, and sanitized failures.
- [ ] Implement canonical URL validation with an injected bounded resolver and fail-closed private-network checks.
- [ ] Keep the policy independent from providers and network orchestration.
- [ ] Run `pnpm --filter @surfgate/security test` and confirm green.

## Task 4: Add durable control-plane schema

**Files:**

- Create: `apps/api/migrations/0004-session-control-plane.sql`
- Create: `apps/api/src/domain/idempotency.ts`
- Create: `apps/api/src/domain/allocation-attempt.ts`
- Create: `apps/api/src/domain/audit-event.ts`
- Create: `apps/api/src/repositories/idempotency-repository.ts`
- Create: `apps/api/src/repositories/allocation-attempt-repository.ts`
- Create: `apps/api/src/repositories/audit-event-repository.ts`
- Modify: `apps/api/src/repositories/session-repository.ts`

- [ ] Write migration/integration tests for immutable audit rows, unique idempotency scope, request-hash conflicts, tenant scoping, one-fallback bounds, and race-safe concurrent-session reservation.
- [ ] Add deterministic forward-only tables and constraints for idempotency records, allocation attempts, and audit events.
- [ ] Define tenant-scoped repository interfaces; do not expose unsafe unscoped resource reads.

## Task 5: Implement PostgreSQL repositories and quota reservation

**Files:**

- Create: `apps/api/src/database/postgres-idempotency-repository.ts`
- Create: `apps/api/src/database/postgres-allocation-attempt-repository.ts`
- Create: `apps/api/src/database/postgres-audit-event-repository.ts`
- Modify: `apps/api/src/database/postgres-session-repository.ts`
- Create: `apps/api/test/database/session-control-plane.integration.test.ts`

- [ ] Add failing real-PostgreSQL tests for atomic create claims, duplicate replay, body conflict, simultaneous duplicates, concurrent session-limit enforcement, cross-tenant isolation, allocation-attempt ordering, and immutable audit storage.
- [ ] Implement transactional tenant advisory locking plus durable idempotency/session reservation.
- [ ] Implement bounded polling/replay state and never hold a transaction across provider calls.
- [ ] Run the isolated database integration tests against a `_test` database.

## Task 6: Implement Redis fail-closed rate limits

**Files:**

- Modify: `apps/api/package.json`
- Create: `apps/api/src/redis/redis-client.ts`
- Create: `apps/api/src/quota/rate-limiter.ts`
- Create: `apps/api/test/redis/rate-limiter.integration.test.ts`
- Modify: `pnpm-lock.yaml`

- [ ] Write failing unit/integration tests for atomic per-tenant limits, window expiry, bounded operations, and Redis-unavailable fail-closed behavior.
- [ ] Add one maintained Redis client and an atomic Lua/fixed-window limiter with bounded connect/command timeouts.
- [ ] Keep Redis out of durable session/routing/audit storage.
- [ ] Run Redis integration tests and clean up test keys.

## Task 7: Implement provider-neutral registry and health snapshots

**Files:**

- Create: `apps/api/src/providers/provider-registry.ts`
- Create: `apps/api/test/providers/provider-registry.test.ts`

- [ ] Write failing tests for deterministic descriptor order, unique canonical identity, bounded health, normalized health failures, selected-candidate resolution, and no concrete routing branches.
- [ ] Implement a registry over injected `BrowserProvider` instances.
- [ ] Ensure provider health failures become unavailable snapshots without marking objects healthy by existence.

## Task 8: Implement session service with routing, allocation, fallback, cleanup, GET, and DELETE

**Files:**

- Create: `apps/api/src/services/session-service.ts`
- Create: `apps/api/src/services/public-session.ts`
- Create: `apps/api/src/services/idempotency-hash.ts`
- Create: `apps/api/test/services/session-service.test.ts`

- [ ] Write failing fake-provider tests for direct Kitesurf/Chromium selection, no compatible runtime, exactly one eligible fallback, fallback disabled, auth/policy failures without fallback, fallback failure stop, allocation cancellation/timeout, cleanup after persistence failure, idempotency replay/race/conflict, quotas, tenant-safe GET, idempotent concurrent DELETE, and uncertain termination.
- [ ] Implement durable state-machine transitions without direct status updates.
- [ ] Persist the router decision before allocation and use router fallback classification/state transitions.
- [ ] Encrypt the complete provider session before persistence and sanitize every public projection.
- [ ] Attempt bounded provider cleanup after post-allocation persistence failure; retain recoverable state on uncertain termination.

## Task 9: Add thin authenticated HTTP routes

**Files:**

- Create: `apps/api/src/http/session-routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/test/session-routes.test.ts`

- [ ] Write failing Fastify injection tests for auth/scope handling, POST/GET/DELETE status semantics, idempotency headers, malformed bodies/IDs, tenant isolation, safe responses, and stable public errors.
- [ ] Register routes using shared runtime schemas and thin calls into `SessionService`.
- [ ] Wire config, repositories, providers, Redis, target policy, telemetry, and graceful shutdown without direct `process.env` reads.

## Task 10: Add audit and observability boundaries

**Files:**

- Modify: `packages/observability/src/index.ts`
- Modify: `apps/api/src/services/session-service.ts`
- Modify: `apps/api/src/http/health-routes.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/app.test.ts`

- [ ] Write failing tests proving bounded labels and secret-free audit/telemetry payloads.
- [ ] Add session create, quota, routing, health, allocation, fallback, persist, terminate, and audit observations.
- [ ] Extend readiness to report PostgreSQL and Redis separately; fail readiness when either required dependency is unavailable.

## Task 11: Generate and verify OpenAPI from runtime schemas

**Files:**

- Create: `apps/api/src/http/openapi.ts`
- Create: `apps/api/test/openapi.test.ts`
- Modify: `docs/API.md`

- [ ] Write a failing contract test for all three v1 paths, Bearer auth, Idempotency-Key, response/error status codes, quota behavior, and absent relay credentials.
- [ ] Build the OpenAPI document directly from the same Zod schemas registered by routes and expose a safe JSON document.
- [ ] Ensure no provider-internal fields or upstream connection data appear in the specification.

## Task 12: Documentation and architecture synchronization

**Files:**

- Modify: `docs/API.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/OBSERVABILITY.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/IMPLEMENTATION_PLAN.md`
- Modify: `docs/LOCAL_DEVELOPMENT.md`
- Create: `docs/adr/0010-session-idempotency-and-quota-coordination.md`

- [ ] Document request lifecycle, durable idempotency/recovery, PostgreSQL concurrency reservations, Redis rate-limit fail-closed semantics, single fallback, cleanup/reconciliation, DELETE behavior, audit events, and relay absence.
- [ ] Mark only SG-0504 through SG-0507 complete after verification.

## Task 13: Full verification and self-review

**Files:**

- Review all changed files.

- [ ] Run focused contract/config/security/API unit tests.
- [ ] Run PostgreSQL, Redis, API integration, and security suites with isolated test infrastructure; shut infrastructure down cleanly.
- [ ] Run router golden and fake/Kitesurf/Chromium conformance suites.
- [ ] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check`.
- [ ] Use the code-review and requesting-code-review skills for an independent final review; fix every P0/P1 finding.
- [ ] Inspect the full diff for secrets, cross-tenant access, quota/idempotency races, long DB transactions, state-machine bypasses, fallback loops, unsafe provider exposure, unbounded operations, schema drift, `any`, and unrelated changes.
