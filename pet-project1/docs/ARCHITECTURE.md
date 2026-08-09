# SurfGate Architecture

## 1. Architecture goals

SurfGate must provide:

- provider-neutral browser allocation,
- deterministic routing,
- safe fallback,
- secure CDP relay,
- tenant isolation,
- horizontal scaling,
- replayable routing decisions,
- low control-plane overhead,
- clear operational visibility.

The architecture separates **control plane** from **browser traffic data plane**.

---

## 2. System context

```text
          ┌──────────────────────────────────────────┐
          │ Client applications / AI agents         │
          │ SDK / REST / Playwright / Puppeteer     │
          └────────────────────┬─────────────────────┘
                               │
                               ▼
                     ┌─────────────────┐
                     │ SurfGate API    │
                     │ Control Plane   │
                     └───────┬─────────┘
                             │
             ┌───────────────┼─────────────────┐
             │               │                 │
             ▼               ▼                 ▼
          Router         Session Store      Audit
             │
             ▼
       Provider Adapter
         /          \
        /            \
 Kitesurf          Chromium
        \            /
         \          /
          upstream CDP
               │
               ▼
        ┌──────────────┐
        │ Relay Plane  │◄──────── Client WebSocket
        └──────────────┘
```

---

## 3. Components

### 3.1 API service

Responsibilities:

- authentication,
- tenant context,
- request validation,
- idempotency,
- quotas,
- session CRUD,
- task submission,
- invoking router,
- provider allocation orchestration,
- relay token issuance,
- audit events.

Must be stateless except for external stores.

The implemented SG-0501 foundation uses Fastify with validated SurfGate request IDs,
central canonical error serialization, structured redacted logging, control-plane
telemetry hooks, and separate liveness/readiness endpoints. Startup never runs database
migrations or starts local infrastructure. Graceful shutdown stops HTTP acceptance before
closing the PostgreSQL pool.

### 3.2 Router package

Pure domain logic.

Inputs:

- requested capabilities,
- tenant policy,
- runtime capability registry,
- provider health snapshot,
- normalized compatibility, efficiency, and latency signals.

Outputs:

- decision,
- selected candidate,
- rejected candidates,
- reason codes,
- score breakdown.

The implemented `routeBrowserRuntime()` function is deterministic and
unit-testable without network or database. It consumes provider-neutral
descriptor/health snapshots rather than `BrowserProvider` instances, so it
cannot allocate sessions. Candidate IDs encode provider, runtime, region, and
configuration profile and are sorted independently of caller insertion order.

Hard capability, tenant policy, configured/health/capacity, maximum duration,
and product safety checks complete before the versioned `router-v1` score is
calculated. The result is a strict persistence-ready `RoutingDecision`; the
future control plane owns physical persistence. The separate fallback reducer
classifies normalized failures and permits at most one cross-runtime allocation
fallback. It never replays browser actions.

The router package depends only on contracts, provider-core, and Zod. It has no
concrete provider, Cloudflare, API framework, storage, or network dependency.
See ADR 0008.

### 3.3 Provider core

Defines:

```ts
interface BrowserProvider {
  descriptor(): ProviderDescriptor
  health(options: ProviderOperationOptions): Promise<ProviderHealth>
  allocate(
    request: ProviderAllocateRequest,
    options: ProviderOperationOptions,
  ): Promise<ProviderSession>
  terminate(
    session: ProviderSessionRef,
    options: ProviderOperationOptions,
  ): Promise<ProviderTerminationResult>
}
```

Provider-core schemas runtime-validate descriptors, normalized health, allocation
requests, internal sessions, operation options, and termination results.
Capability declarations and requirements reuse `packages/contracts` as their
only enum/schema source.

Each asynchronous operation receives a finite `timeoutMs` and optional
`AbortSignal`; provider implementations must bound upstream work by both.
Termination is idempotent from SurfGate's perspective: an upstream session that
is already gone or not found resolves as `already_terminated` unless the adapter
has evidence of a real cleanup failure.

`ProviderSession` is internal and must never be serialized as a public API
response. Its connection object contains an upstream websocket endpoint and an
opaque credential reference; raw provider tokens and authorization headers are
not part of the provider-core session contract. A server-side resolver later
turns the reference into connection credentials for the relay. The endpoint
must not contain URL userinfo, a query string, or a fragment, so credentials
cannot be smuggled into a URL.

Provider failures use the stable `ProviderError` taxonomy for configuration,
authorization, cancellation, timeout, rate/capacity, transient upstream,
unsupported behavior, connection, invalid response, termination, and unknown
errors. Canonical messages prevent raw upstream failures from crossing this
boundary.

### 3.4 Kitesurf provider

Encapsulates Cloudflare Browser Run calls with Kitesurf selection.

Cloudflare-specific transport and lifecycle mechanics shared with the Chromium
adapter live in the private `packages/provider-cloudflare` package. That layer
owns fixed-host URL construction, header authentication, bounded response
handling, timeout/cancellation, normalized Cloudflare failures, allocation
validation/cleanup, and idempotent termination. Runtime selectors,
capabilities, descriptors, and public factories remain in their concrete
provider packages. Neither provider imports the other, and provider-core and
contracts remain Cloudflare-independent. See ADR 0007.

Responsibilities:

- construct upstream endpoint,
- attach Cloudflare authorization server-side,
- expose capability declaration,
- classify upstream errors,
- allocate/terminate,
- provider health.

No routing policy.

The adapter uses the current Kitesurf lifecycle namespace for control calls:

```text
POST   /client/v4/accounts/{account}/browser-run/devtools/browser?browser=kitesurf
GET    /client/v4/accounts/{account}/browser-run/devtools/session?limit=1
DELETE /client/v4/accounts/{account}/browser-run/devtools/browser/{sessionId}
```

Allocation returns a Cloudflare session ID and an internal WSS connection URL.
As observed against the live API on 2026-08-08, Cloudflare accepts the current
`/browser-run` creation path but may return the session WSS URL under the older
`/browser-rendering` namespace. The adapter accepts only either exact namespace
on `api.cloudflare.com`, beneath the configured account and exact returned
session ID, with no URL credentials, query, or fragment. This compatibility
rule is private to the adapter and does not change provider-core or public
contracts.

The credential reference in `ProviderSession` is opaque. The API token remains
inside the provider transport and is sent only as an Authorization header. The
future relay resolver must obtain credentials server-side; the provider session
must never be serialized to a client.

Kitesurf lifecycle calls have one caller-controlled timeout and AbortSignal and
perform no internal retries. DELETE is idempotent from SurfGate's perspective:
the first accepted close is `terminated`, a bounded expiring record makes a
recent sequential repeat `already_terminated`, concurrent close calls are
single-flight with independent caller cancellation budgets, and Cloudflare
`404` is `already_terminated`. If the leading caller aborts or times out, a
still-valid joiner may continue one replacement close under its own budget. If
allocation returns a valid session ID followed by unsafe connection metadata,
the adapter uses only the allocation deadline's remaining time for one
best-effort DELETE before returning the normalized error.

### 3.5 Chromium provider

The production adapter is Cloudflare Browser Run Chromium. It uses Cloudflare's
current stable CDP HTTP lifecycle without a browser selector:

```text
POST   /client/v4/accounts/{account}/browser-rendering/devtools/browser?keep_alive={idleMs}
GET    /client/v4/accounts/{account}/browser-rendering/devtools/session?limit=1
DELETE /client/v4/accounts/{account}/browser-rendering/devtools/browser/{sessionId}
```

Omitting `browser=kitesurf` selects the stable Chromium pool. Allocation
accepts only a clean `wss://api.cloudflare.com` connection URL beneath the
configured account, `/browser-rendering` namespace, and exact session ID, with
no userinfo, query, or fragment. Authentication uses the same server-side
Cloudflare bearer token as Kitesurf and never enters provider metadata.

`keep_alive` is an inactivity window, not SurfGate's absolute requested session
duration. The adapter clamps it to Cloudflare's documented ten-minute window;
an active session can outlive that window when the future relay sends commands
within it. Cloudflare may still close sessions during rollouts. The normalized
`expiresAt` remains the caller-requested SurfGate limit.

Chromium uses the same bounded allocation, health, error, cleanup, cancellation,
and idempotent termination implementation as Kitesurf through the private
Cloudflare layer, with a separate runtime profile and capability declaration.
No routing or fallback policy is embedded in the adapter.

The lightweight session-list health probe establishes reachability and
authorization only; a healthy result reports capacity as `unknown`, not
`available`. Cloudflare documents 429 responses for both acquisition cadence
and concurrency pressure but does not currently provide a stable machine code
that distinguishes those conditions. SurfGate maps a generic 429 to
`PROVIDER_RATE_LIMITED` and only maps the exact documented daily browser-time
quota signal to `PROVIDER_CAPACITY_EXHAUSTED` until Cloudflare publishes a
stable concurrency-exhaustion signal.

Development target:

- optionally local Chromium CDP endpoint.

Do not make local Chromium assumptions part of the public API.

### 3.6 Relay service

Separate data plane for CDP WebSocket traffic.

Why separate:

- different scaling profile,
- long-lived connections,
- different resource/timeout needs,
- avoids coupling API request throughput to WebSocket concurrency.

Responsibilities:

- validate signed relay credential,
- authorize session,
- resolve encrypted upstream connection info,
- open upstream,
- proxy frames,
- apply backpressure/limits,
- close cleanly,
- emit connection metrics.

Relay should not interpret browser semantics unless required for security or compatibility. Avoid turning it into a full CDP proxy parser in v1.

### 3.7 Worker

Managed tasks:

- extraction,
- screenshot,
- PDF,
- cleanup/reconciliation,
- compatibility probes.

Workers can obtain routed sessions via internal APIs or call shared domain packages directly depending deployment topology.

### 3.8 PostgreSQL

Durable:

- tenants,
- API-key metadata,
- sessions,
- routing decisions,
- tasks,
- artifacts metadata,
- audit records,
- policies.

The control-plane data layer is SQL-first through `pg`; see ADR 0009. Committed migrations
are executed explicitly and checksum recorded. Repositories live under `apps/api`, use
parameterized SQL, validate rows at the boundary, and expose tenant-scoped session and
routing-decision reads. Session transitions use a database version compare-and-set rather
than process-local locks. `packages/router` remains database-independent.

Provider session references are encrypted AES-256-GCM envelopes bound to tenant/session
identity before persistence. API-key rows contain a non-secret prefix and salted scrypt
hash, never the plaintext key.

### 3.9 Redis

Ephemeral:

- rate limits,
- concurrency counters,
- short-lived session registry/cache,
- distributed locks,
- revocation markers,
- idempotency acceleration,
- queue state if BullMQ is used.

Redis must not be the only durable source of truth for audit/session history.

Epic 5 uses Redis only for the atomic per-tenant request-rate window. Redis failure
fails session creation closed. PostgreSQL owns durable idempotency, concurrent-session
reservation, routing decisions, allocation attempts, sessions, and audit events.

### 3.10 Object storage

S3-compatible:

- screenshots,
- PDFs,
- optional traces/debug bundles.

Objects:

- tenant-prefixed,
- encrypted,
- retention bounded,
- private by default.

---

## 4. Control-plane request

```text
POST /v1/sessions
   │
   ▼
Authenticate tenant
   │
   ▼
Validate request
   │
   ▼
Check quota + idempotency
   │
   ▼
Get capability + health snapshot
   │
   ▼
Route
   │
   ▼
Persist routing decision
   │
   ▼
Allocate provider session
   │
   ├── failure classified + fallback allowed
   │        │
   │        ▼
   │    allocate fallback
   │
   ▼
Persist ACTIVE session
   │
   ▼
Return provider-neutral response
```

The relay step is intentionally absent until Epic 6. The control plane never substitutes
the upstream provider endpoint or a placeholder relay credential.

---

## 5. CDP relay path

```text
Client
  │ WSS + signed SurfGate token
  ▼
Relay
  │ verify signature
  │ verify exp/aud/session/tenant
  │ check revocation/session state
  ▼
Resolve upstream secret
  │
  ▼
Upstream CDP WebSocket
  │
  └════ bidirectional bounded streaming ════
```

The public relay token references the session but never contains provider credentials.

---

## 6. Failure domains

### API failure

Does not automatically kill active relay connections.
New allocations may fail.

### Relay instance failure

Only sessions connected through that relay instance are interrupted.
Provider cleanup/reconciliation eventually closes leaked upstream sessions.

### Redis failure

Control plane enters degraded mode.
Do not create unsafe duplicate concurrency state.
Durable session metadata remains in Postgres.

### Postgres failure

New session creation should fail rather than create unaudited/untracked sessions.
Existing relay sessions may continue for a bounded time if authorization state is cached safely.

### Provider failure

Router marks provider degraded/unavailable and selects an alternative if policy/capabilities allow.

---

## 7. Routing boundaries

The router selects a **runtime/provider candidate**.

The provider allocates it.

The relay connects to it.

Do not merge these responsibilities.

Bad:

```text
router -> directly opens Cloudflare WebSocket
```

Good:

```text
router -> Candidate
provider -> ProviderSession
relay -> streams ProviderSession
```

---

## 8. Capability model

Capability state:

```text
supported
unsupported
experimental
unknown
```

A requested hard capability passes only if:

```text
supported
```

unless the client explicitly opts into experimental behavior.

Capabilities have metadata:

- runtime,
- provider,
- capability version,
- source: static/conformance/override,
- verifiedAt.

---

## 9. Compatibility history

Future-friendly record:

```text
domainHash / normalized domain
runtime
taskClass
successCount
failureCount
lastFailureClass
rollingSuccessRate
sampleWindow
```

Do not automatically learn from potentially tenant-sensitive full URLs.

Domain-level statistics should be privacy reviewed before shared across tenants.

MVP may keep compatibility history tenant-local.

---

## 10. Deployment topology

### Local

```text
docker compose
  Postgres
  Redis
  optional OTel collector

node processes
  API
  Relay
  Worker
```

### Production

Any container/VM platform that provides:

- TLS ingress,
- autoscaling,
- Postgres,
- Redis,
- object storage,
- secret manager,
- OTel export.

SurfGate should not require Cloudflare for its own control plane even though Kitesurf initially requires Cloudflare Browser Run.

---

## 11. Multi-region path

Not MVP.

Design constraints now:

- globally unique IDs,
- no process-local source of truth,
- region stored on sessions,
- relay connects to session's home region if required,
- routing policies versioned,
- timestamps UTC.

Future choices:

- region-pinned sessions,
- globally replicated tenant/config metadata,
- regional Redis,
- Postgres primary + read replicas or distributed SQL.

---

## 12. Data consistency

Strong consistency required for:

- session ownership,
- terminal session state,
- API key revocation,
- quota decisions when limits would otherwise be exceeded,
- audit creation for privileged actions.

Eventual consistency acceptable for:

- aggregate dashboards,
- compatibility analytics,
- provider health rolling metrics.

---

## 13. Security boundaries

Trust boundaries:

```text
Internet client
  | TB1
SurfGate API
  | TB2
Internal stores
  | TB3
Provider API/CDP
  | TB4
Untrusted website content
```

No data coming from the target website is trusted.

Provider errors are also untrusted strings and must be redacted before external exposure.

---

## 14. Architectural invariants

1. Clients never receive provider credentials.
2. Router never directly speaks provider SDK.
3. Provider adapters do not decide global routing.
4. Contracts do not depend on implementation frameworks.
5. Active sessions have exactly one owning tenant.
6. Terminal sessions never reactivate.
7. Fallback is bounded.
8. Raw CDP traffic is not retained by default.
9. Private network access is denied unless explicitly configured.
10. Every external request is traceable by request ID.
11. Durable session and routing-decision reads are tenant scoped.
12. Database migration execution is separate from application startup.

---

## 15. Architecture decision process

Material choices require ADRs when they change:

- data store,
- runtime transport,
- public API contract,
- routing algorithm semantics,
- auth/token design,
- queue/workflow engine,
- service boundaries.

Use `docs/adr/`.
