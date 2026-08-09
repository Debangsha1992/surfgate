# SurfGate Implementation Plan

Use this file as the ordered engineering backlog.

Work through bounded slices and keep `pnpm check` green.

---

## Epic 0 — Bootstrap

### SG-0001 Monorepo baseline
Create:
- pnpm workspace
- TypeScript strict config
- ESLint
- formatter
- Vitest
- build scripts
- package boundaries

Acceptance:
- empty packages compile
- `pnpm check` passes

### SG-0002 Local infrastructure
Create docker compose for:
- Postgres
- Redis
- OTel collector optional

Acceptance:
- health checks
- documented commands

### SG-0003 Config package
Runtime-validate environment variables.

Acceptance:
- no `process.env` outside package
- unit tests

---

## Epic 1 — Contracts and provider core

### SG-0101 IDs and common errors
Implement:
- opaque IDs
- error code taxonomy
- error serialization

### SG-0102 Capability model
Implement:
- capability names
- support state
- requirement state
- matcher

### SG-0103 Provider interface
Implement:
- descriptor
- health
- allocate
- terminate

### SG-0104 Fake provider
In-memory deterministic provider for tests.

### SG-0105 Conformance suite
Reusable tests provider adapters must satisfy.

---

## Epic 2 — Kitesurf provider

### SG-0201 Cloudflare config
Account ID/API token/base URL.

### SG-0202 Kitesurf descriptor
Declare current capabilities from verified documentation and conformance.

### SG-0203 Allocate
Create upstream connection details using Cloudflare Browser Run CDP endpoint with Kitesurf selection.

### SG-0204 Terminate/cleanup
Implement provider lifecycle based on supported Browser Run semantics.

### SG-0205 Error normalization
Map:
- auth,
- rate limit,
- timeout,
- unsupported,
- 5xx,
- connection.

### SG-0206 Live conformance
Trusted CI only.

---

## Epic 3 — Chromium provider

Status: complete as of 2026-08-08.

Implemented the same provider interface and exact shared conformance suite as
Kitesurf, using a private shared Cloudflare transport/lifecycle layer.

Initial production adapter:
- Cloudflare Browser Run Chromium.
- current `/browser-rendering/devtools` HTTP session lifecycle.
- stable Chromium selection by omitting the Kitesurf selector.
- bounded allocation, health, error normalization, cleanup, cancellation, and
  idempotent termination.
- separately gated live lifecycle coverage.

Optional dev adapter:
- local Chromium CDP endpoint remains deferred and was not required for Epic 3.

---

## Epic 4 — Router

Status: complete as of 2026-08-08.

Implemented as pure deterministic domain logic in `packages/router`:

- provider-neutral candidate construction from descriptors and health snapshots;
- hard capability, experimental, policy, health, capacity, duration, strict
  runtime, and product-safety filtering before score;
- immutable versioned `router-v1` weights/defaults and stable tie-breaking;
- stable reason-code registry and per-candidate explanations;
- strict serializable `RoutingDecision` with correlation IDs, versions, health
  snapshots, effective fallback policy, and score/rejection details;
- normalized fallback classification and a maximum-one cross-runtime allocation
  fallback state reducer;
- offline golden, invariant, and boundary suites.

SG-0405 delivers the complete persistence-ready decision schema but no database
migration or ORM. The repository has not established the Epic 5 control-plane
database layer, so physical PostgreSQL persistence remains sequenced with that
layer rather than coupling infrastructure into `packages/router`. See ADR 0008.

### SG-0401 Candidate builder
Provider descriptors -> candidate list.

### SG-0402 Hard filter
Capabilities, policy, health.

### SG-0403 Deterministic scoring
Versioned weights.

### SG-0404 Reason codes
Stable public/internal codes.

### SG-0405 Decision persistence model
Create the persistence-ready schema. Wire physical storage with the established
control-plane persistence layer in Epic 5; do not introduce an ORM in the pure
router package.

### SG-0406 Fallback classifier
Bounded one-step fallback.

### SG-0407 Golden routing suite
Fixtures in repository.

---

## Epic 5 — Tenant/API control plane

### SG-0501 Fastify app skeleton
- request ID
- logger
- error handler
- OTel

Status: complete as of 2026-08-08. Fastify bootstrap, graceful lifecycle, validated
request IDs, redacted structured logging, canonical error boundary, runtime response
validation, PostgreSQL-backed readiness, liveness, and telemetry hooks are implemented.

### SG-0502 Tenant/API key
- key hashing
- auth middleware
- scopes

Status: complete as of 2026-08-08. Durable tenant/API-key metadata, one-time key issuance,
salted scrypt verification, expiry/revocation/scopes, and authenticated tenant context are
implemented without plaintext persistence.

### SG-0503 Session table and state machine

Status: complete as of 2026-08-08. SQL-first migrations/repositories, tenant-scoped
sessions and routing decisions, encrypted provider session references, and PostgreSQL CAS
state transitions are implemented. See ADR 0009. No production session HTTP endpoint or
provider allocation orchestration is included.

### SG-0504 POST /v1/sessions
- validation
- idempotency
- quota
- route
- allocate
- fallback
- persist
- audit

Status: complete as of 2026-08-09. The thin Fastify route calls a tenant-scoped session
service with durable idempotency, PostgreSQL concurrency reservation, Redis rate limits,
deterministic routing, protected provider allocation, one classified cross-runtime fallback,
allocation-attempt history, immutable audit events, and bounded cleanup.

### SG-0505 GET /v1/sessions/:id

Status: complete as of 2026-08-09. Reads are authenticated, scope-checked, tenant-scoped,
and projected through the provider-secret-free public session schema.

### SG-0506 DELETE /v1/sessions/:id
Idempotent termination.

Status: complete as of 2026-08-09. Repeated/concurrent termination is safe, upstream
already-gone behavior is normalized by providers, and uncertain failures remain recoverable.

### SG-0507 OpenAPI
Generated from schemas.

Status: complete as of 2026-08-09. `/openapi.json` is assembled from the same Zod runtime
schemas used by Fastify and documents authentication, idempotency, errors, and relay absence.

---

## Epic 6 — Relay

### SG-0601 Token service
Signed short-lived session tokens.

### SG-0602 Relay upgrade auth
Tenant/session/audience/expiry.

### SG-0603 Upstream resolver
Provider reference -> upstream URL/headers server-side.

### SG-0604 Bidirectional proxy
- backpressure
- bounded frame
- cancellation
- cleanup

### SG-0605 Revocation/termination

### SG-0606 Relay load harness

---

## Epic 7 — Security

### SG-0701 URL policy
Scheme + canonicalization.

### SG-0702 IP policy
IPv4/IPv6 private/loopback/link-local.

### SG-0703 Redirect validation

### SG-0704 DNS rebinding strategy

### SG-0705 Log redaction

### SG-0706 Cross-tenant tests

### SG-0707 Security CI
secret scan + dependency scan.

---

## Epic 8 — Managed tasks

### SG-0801 Task contract/state

### SG-0802 Extract

### SG-0803 Screenshot

### SG-0804 PDF

### SG-0805 Artifact storage

### SG-0806 Worker execution/retries

No automatic replay of unsafe mutating browser actions.

---

## Epic 9 — Observability

### SG-0901 Core metrics

### SG-0902 Routing traces

### SG-0903 Provider metrics

### SG-0904 Relay metrics

### SG-0905 Dashboards

### SG-0906 Alerts

---

## Epic 10 — Production hardening

- provider circuit breakers
- reconciliation worker
- chaos tests
- capacity/load
- graceful shutdown
- DB migration runbook
- key rotation
- retention jobs
- security review
