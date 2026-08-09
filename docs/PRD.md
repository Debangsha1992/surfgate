# Product Requirements Document — SurfGate

**Product:** SurfGate  
**Category:** Infrastructure for AI agents  
**Document status:** v0.1 implementation baseline  
**Primary audience:** engineering, product, security, developer relations  
**Date:** 2026-08-07

---

## 1. Executive summary

SurfGate is a **browser runtime router and execution gateway for AI agents**.

It gives developers a single API/SDK/CDP endpoint for browser execution while dynamically selecting an appropriate underlying runtime. The initial runtime pair is:

1. Cloudflare Kitesurf — preferred for compatible, short-lived, stateless, high-volume workloads.
2. Chromium — compatibility fallback for workloads requiring browser features, persistence, or rendering fidelity that Kitesurf cannot currently provide.

SurfGate separates the agent from browser-vendor decisions.

The product is analogous to model gateways that route LLM requests across providers, except the routed resource is a browser runtime.

SurfGate also provides the infrastructure that production browser agents need but do not want to rebuild individually:

- runtime capability matching,
- fallback,
- session lifecycle management,
- authenticated CDP relaying,
- quotas,
- retries,
- policy controls,
- observability,
- auditability,
- provider health,
- cost accounting,
- compatibility signals.

SurfGate is not itself an AI agent.

---

## 2. Problem statement

Browser-enabled agents currently face several infrastructure problems.

### 2.1 Runtime lock-in

Applications often embed a specific browser implementation or hosted browser vendor directly into agent code.

Consequences:
- switching runtimes is invasive,
- credentials spread across services,
- provider failures propagate directly to agents,
- application code contains provider-specific behavior.

### 2.2 Efficiency vs. compatibility trade-offs

Full Chromium provides broad compatibility but carries material CPU/memory overhead.

Lighter runtimes can be more efficient but may not support all web APIs, rendering requirements, authenticated workflows, or browser-specific behaviors.

Developers should not have to make this decision manually for every task.

### 2.3 Fragile fallback

When a runtime fails, application teams commonly implement ad hoc retry logic.

That creates:
- duplicate work,
- retry storms,
- infinite loops,
- inconsistent error handling,
- poor visibility into why a fallback happened.

### 2.4 Weak operational visibility

Teams need to answer:

- Which runtime was selected?
- Why?
- What did the allocation cost?
- Which domains fail on which runtimes?
- How often did fallback rescue the task?
- Are provider errors increasing?
- Which tenants are using the most capacity?
- Are failures application errors, runtime incompatibility, policy denials, or provider incidents?

### 2.5 Security

A browser control channel is powerful. CDP can navigate, execute JavaScript, inspect content, read/write cookies, and control the page.

A production gateway must protect:
- provider secrets,
- tenant isolation,
- internal networks,
- artifact data,
- session tokens,
- audit records.

---

## 3. Kitesurf product context

As verified against Cloudflare's Kitesurf documentation updated August 7, 2026:

- Kitesurf is an agent-first browser running on Cloudflare Workers.
- It is exposed through Browser Run.
- It supports a subset of Chrome DevTools Protocol.
- Cloudflare states that Playwright, Puppeteer, chrome-remote-interface, and CDP/MCP agents can connect through the Browser Run interface.
- Cloudflare positions Kitesurf for ephemeral, isolated, stateless, bursty AI workloads.
- Cloudflare reports lower CPU and memory usage than warm Chromium on its published screenshot and HTML-extraction benchmark corpus.
- Cloudflare explicitly recommends Chromium instead for workloads requiring video, WebGL, real-TLS bot-challenge behavior, or long persistent authenticated sessions.
- Kitesurf remains early-stage/beta and Cloudflare is expanding CDP, rendering, WPT coverage, and production readiness.
- Kitesurf is selected by adding `browser=kitesurf` to the current Browser Run
  Quick Action or CDP endpoint.
- The current documented Kitesurf CDP endpoint is
  `wss://api.cloudflare.com/client/v4/accounts/{account}/browser-run/devtools/browser?browser=kitesurf`.
- A Browser Run API token requires the `Browser Rendering - Edit` permission
  (called `Browser Rendering Write` in the API reference).

SurfGate MUST treat these as runtime capabilities that can change over time, not permanent assumptions hard-coded into client APIs.

Primary source:
https://developers.cloudflare.com/browser-run/kitesurf/

### 3.1 Cloudflare Browser Run Chromium context

As re-verified from current official Cloudflare documentation on August 8,
2026:

- Browser Run's stable runtime is headless Chromium exposed through standard
  CDP.
- The current direct CDP endpoint is
  `wss://api.cloudflare.com/client/v4/accounts/{account}/browser-rendering/devtools/browser`.
- The HTTP session lifecycle is POST to create and DELETE by session ID to
  close; successful close responses are `closing` or `closed`.
- Authentication is a server-side bearer token with `Browser Rendering - Edit`
  (`Browser Rendering Write` in the API reference).
- `keep_alive` is an inactivity timeout: 60 seconds by default and up to ten
  minutes in the current product guide. Active sessions have no fixed maximum
  lifetime, but may close during Browser Run releases.
- The generated API reference currently advertises a 1,200,000 ms upper bound
  while the product limits, CDP guides, and Wrangler documentation state ten
  minutes. SurfGate uses the conservative documented 600,000 ms bound until
  Cloudflare reconciles those official sources.
- Current defaults are three concurrent browsers and one new instance every 20
  seconds on Workers Free, or 120 concurrent browsers and one new instance per
  second on Workers Paid. Tabs do not consume additional browser-instance
  concurrency.
- Cloudflare currently reports both acquisition cadence and concurrency
  pressure through HTTP 429 without a documented stable subcode. SurfGate
  conservatively classifies generic 429 as rate limiting; only the exact
  documented daily browser-time quota condition is classified as capacity
  exhaustion. Provider health therefore does not claim available capacity from
  a successful session-list probe.
- Browser Run documents persistent/reusable sessions, storage state, multiple
  tabs, JavaScript/DOM/network inspection, screenshots, and PDFs. Its Playwright
  documentation still lists video as not fully supported.
- Browser Run always identifies its traffic as a bot; Chromium support must not
  be presented as a bot-protection bypass.

The Browser Run product rename did not change the current generated API/CDP
namespace from `/browser-rendering`. Chromium uses that namespace without a
Kitesurf selector. The two providers reuse the same Cloudflare transport and
authentication model while retaining distinct runtime profiles.

---

## 4. Product vision

> Give any AI agent safe, observable, cost-efficient access to browser runtimes through one stable interface.

Longer term, SurfGate should become the browser execution substrate underneath:
- AI assistants,
- research agents,
- QA agents,
- support agents,
- coding agents,
- workflow automation,
- data extraction pipelines,
- monitoring agents.

The user should express **what the workload requires**, not which provider SDK to call.

---

## 5. Product principles

### P1. Capability-driven, not vendor-driven

Clients describe requirements:

```json
{
  "capabilities": {
    "javascript": true,
    "screenshot": true,
    "webgl": false,
    "persistentAuth": false
  }
}
```

SurfGate decides which runtime can satisfy them.

### P2. Deterministic first

Initial routing must be explainable and reproducible.

ML/LLM-based routing is a future optimization, not an MVP dependency.

### P3. Fast path + compatibility fallback

Kitesurf should be preferred when compatible and healthy.

Chromium should rescue workloads that Kitesurf cannot safely/compatibly execute.

### P4. Provider credentials never reach clients

Clients authenticate to SurfGate.
SurfGate authenticates to providers.

### P5. Observable by default

Every routing decision, allocation, fallback, session, and error produces structured telemetry.

### P6. Security is a control-plane feature

URL policy, tenant isolation, token expiry, egress restrictions, and log redaction are core requirements.

### P7. Runtime capability is empirical

Declared provider capabilities are combined with conformance tests and observed domain compatibility.

---

## 6. Target users

### Persona A — AI infrastructure engineer

Needs to provide browser execution to many internal agent teams.

Wants:
- one platform,
- cost controls,
- security,
- reliability,
- observability,
- provider independence.

### Persona B — Agent application developer

Wants a browser without learning browser infrastructure.

Needs:
- simple SDK,
- predictable errors,
- automatic fallback,
- local development,
- minimal provider configuration.

### Persona C — Platform/security engineer

Needs:
- auditability,
- egress controls,
- tenant isolation,
- credential containment,
- quotas,
- policy enforcement.

### Persona D — Open-source contributor / researcher

Wants:
- reproducible routing,
- provider conformance tests,
- transparent decision logic,
- benchmarkability.

---

## 7. Jobs to be done

1. "When my agent needs a browser, give it one without making the agent know which provider to use."
2. "When the lightweight runtime is incompatible, transparently retry on a compatible runtime."
3. "When browser execution fails, tell me exactly where and why."
4. "When many agents run simultaneously, enforce fair limits and prevent resource exhaustion."
5. "When I add a new browser backend, let me implement one adapter rather than changing every application."
6. "When security asks what the agent accessed, give me a trustworthy audit record without logging sensitive page content."

---

## 8. Scope

### 8.1 MVP

MVP includes:

#### Provider abstraction
- provider capability declaration
- provider health
- allocate session
- terminate session
- normalized errors
- provider metadata

#### Initial providers
- Cloudflare Browser Run with Kitesurf
- Chromium provider
  - Cloudflare Browser Run Chromium is the first production-compatible target
  - the stable Cloudflare CDP path uses `/browser-rendering/devtools` without a
    Kitesurf selector
  - local/remote Chromium endpoint support may be included for development

#### Runtime router
- hard capability filtering
- provider/tenant policy filtering
- deterministic scoring
- stable reason codes
- bounded fallback

#### Session API
- create session
- inspect session
- terminate session
- short-lived client connection token
- provider-neutral metadata

#### CDP relay
- SurfGate WebSocket endpoint
- upstream credential isolation
- session authorization
- timeouts
- backpressure
- bounded message sizes
- cleanup

#### Managed one-shot task API
At minimum:
- HTML/text extraction
- screenshot
- PDF, when runtime supports it

This API may initially be implemented after session routing if sequencing requires it, but it is part of the first product surface.

#### Security
- API key or signed token auth
- tenant isolation
- SSRF/private-network protection
- scheme validation
- redirect validation
- provider secret containment
- log redaction
- audit events

#### Observability
- structured logs
- distributed traces
- core metrics
- routing/fallback analytics
- provider health indicators

#### Developer experience
- TypeScript SDK
- CLI smoke-test command
- local development environment
- examples
- deterministic fixtures
- documentation

### 8.2 Post-MVP

- Python SDK
- MCP server
- policy DSL
- multi-region control plane
- compatibility learning by domain/task class
- cost-aware dynamic weights
- additional browser providers
- tenant dashboards
- budgets and billing
- historical compatibility recommendations
- session pooling where compatible
- durable workflow integrations
- private-network connector
- enterprise SSO/RBAC
- Bring Your Own Browser endpoint

---

## 9. Explicit non-goals

SurfGate will not:

- build an autonomous LLM browser agent,
- decide the semantic goal of an agent,
- bypass CAPTCHAs,
- implement stealth browsing for protection evasion,
- spoof TLS/browser fingerprints to defeat bot systems,
- sell proxies or rotating identities,
- provide credential harvesting,
- retain full browser traffic by default,
- guarantee every website works on every runtime,
- emulate unsupported runtime capabilities,
- silently route around tenant security policy.

---

## 10. Primary workflows

### 10.1 Routed CDP session

```text
Client
  │ POST /v1/sessions
  ▼
SurfGate API
  │ auth / quota / policy
  ▼
Router
  │ choose runtime
  ▼
Provider Adapter
  │ allocate upstream
  ▼
Session Registry
  │
  └── returns SurfGate relay URL + short-lived token

Client
  │
  └── WSS /v1/sessions/{id}/cdp
          │
          ▼
       Relay
          │
          ▼
   Upstream Runtime
```

### 10.2 Kitesurf fallback to Chromium

```text
Request
  ↓
Capability filter
  ↓
Kitesurf eligible
  ↓
Allocate Kitesurf
  ↓
classified incompatibility/allocation failure
  ↓
fallback policy permits
  ↓
Allocate Chromium
  ↓
return session + fallback metadata
```

### 10.3 Hard capability selection

Request:

```json
{
  "capabilities": {
    "webgl": true
  }
}
```

If Kitesurf capability registry says `webgl=false`:

```text
Kitesurf: REJECTED_CAPABILITY_WEBGL
Chromium: ELIGIBLE
```

No trial failure is required.

---

## 11. Functional requirements

### FR-001 Tenant authentication

Every external API request MUST be authenticated.

MVP can use hashed API keys associated with tenants.

Requirements:
- keys displayed once,
- hashes stored,
- key prefix for lookup,
- revocation,
- optional expiry,
- audit events,
- no plaintext key logs.

### FR-002 Create session

Endpoint:

```text
POST /v1/sessions
```

Request can specify:
- target URL optionally,
- required capabilities,
- preferred runtime optionally,
- allowed fallback behavior,
- maximum session duration,
- region preference if available,
- metadata tags,
- idempotency key.

Response includes:
- SurfGate session ID,
- status,
- selected runtime class,
- provider alias,
- routing reasons,
- relay endpoint/token or token exchange path,
- expiry.

Provider secrets MUST NOT be returned.

### FR-003 Get session

```text
GET /v1/sessions/{sessionId}
```

Returns tenant-safe session state and routing metadata.

### FR-004 Terminate session

```text
DELETE /v1/sessions/{sessionId}
```

Must be idempotent.

Termination closes:
- relay connection,
- upstream runtime,
- temporary credentials,
- active task references.

### FR-005 Router

The router MUST:

1. validate requested capabilities,
2. determine eligible runtimes,
3. reject unhealthy or policy-blocked candidates,
4. score eligible candidates deterministically,
5. choose a candidate,
6. emit structured reasons,
7. support bounded fallback.

### FR-006 Capability registry

Capabilities are versioned and testable.

Examples:

```text
javascript
dom
xhr
svg
screenshot
pdf
webgl
video
persistentAuth
realBrowserTLS
downloads
uploads
multiTab
longSession
```

The model must distinguish:
- supported,
- unsupported,
- unknown,
- experimental.

`unknown` MUST NOT be treated as supported for a hard requirement.

### FR-007 Provider health

Providers expose:
- configured / not configured,
- healthy / degraded / unavailable,
- last successful probe,
- recent error ratio,
- capacity/rate-limit signal if available.

### FR-008 Fallback

Fallback may occur only for classified errors allowed by policy.

Example eligible:
- runtime incompatibility,
- transient upstream failure,
- provider capacity/rate limit,
- allocation timeout.

Example ineligible:
- tenant policy denial,
- invalid request,
- authentication failure,
- target forbidden by egress policy.

### FR-009 WebSocket relay

Relay MUST:
- authenticate,
- authorize session ownership,
- validate token expiry and audience,
- establish upstream using provider secret,
- stream bidirectionally,
- implement backpressure,
- bound frame size and queued bytes,
- enforce idle/absolute timeout,
- terminate on revoke/delete,
- avoid raw payload logging.

### FR-010 Managed tasks

Support provider-neutral tasks:

```text
extract
screenshot
pdf
```

Task API must expose:
- runtime selection,
- timeout,
- result metadata,
- artifact references,
- fallback information.

### FR-011 Idempotency

Session/task creation MUST support idempotency keys scoped to tenant + endpoint.

Repeated requests with the same key and equivalent body return the prior result.

Same key with conflicting body returns `IDEMPOTENCY_CONFLICT`.

### FR-012 Quotas

MVP quotas:
- requests/minute,
- concurrent sessions,
- maximum session duration,
- task concurrency,
- artifact size.

### FR-013 Audit log

Security-relevant actions produce immutable audit events:
- credential created/revoked,
- session created/terminated,
- policy denied,
- provider selected,
- fallback,
- admin changes.

Audit events contain metadata, not page content.

### FR-014 Artifacts

Screenshots/PDFs/traces are stored in S3-compatible object storage.

Requirements:
- tenant namespace,
- encryption,
- signed download URLs,
- retention policy,
- content type,
- size limit,
- auditability.

---

## 12. Routing requirements

Detailed algorithm lives in `docs/ROUTING.md`.

Required properties:

- deterministic for identical input + policy + health snapshot,
- hard constraints evaluated before score,
- tie-break deterministic,
- reason codes stable,
- decision record replayable,
- no LLM dependency,
- bounded fallback,
- provider health incorporated,
- tenant overrides explicit.

Initial conceptual score:

```text
score =
  runtimePreference
+ compatibilityHistory
+ providerHealth
+ costEfficiency
+ latencyPreference
- capacityPressure
```

Exact weights are configuration/policy, not API contract.

---

## 13. Data model

Minimum entities:

### Tenant
- id
- name
- status
- plan
- createdAt

### APIKey
- id
- tenantId
- keyPrefix
- keyHash
- scopes
- expiresAt
- revokedAt

### Session
- id
- tenantId
- status
- requestedCapabilities
- selectedRuntime
- selectedProvider
- providerSessionReference encrypted/opaque
- routingDecisionId
- createdAt
- connectedAt
- expiresAt
- terminatedAt
- terminationReason

### RoutingDecision
- id
- tenantId
- requestId
- policyVersion
- capabilitySnapshotVersion
- candidates
- selectedCandidate
- reasonCodes
- fallbackFrom optional
- createdAt

### ProviderHealthSnapshot
- provider
- runtime
- status
- metrics
- capturedAt

### Task
- id
- tenantId
- type
- status
- sessionId optional
- request
- outputMetadata
- errorCode
- createdAt
- completedAt

### Artifact
- id
- tenantId
- taskId/sessionId
- objectKey
- mediaType
- sizeBytes
- expiresAt

### AuditEvent
- id
- tenantId
- actor
- action
- resourceType
- resourceId
- metadata
- createdAt

---

## 14. State models

### Session

```text
PENDING
  ↓
ROUTING
  ↓
ALLOCATING
  ├── ACTIVE
  ├── FALLBACK_ALLOCATING
  └── FAILED

FALLBACK_ALLOCATING
  ├── ACTIVE
  └── FAILED

ACTIVE
  ├── TERMINATING
  ├── EXPIRED
  └── FAILED

TERMINATING
  └── TERMINATED
```

Terminal:
- `TERMINATED`
- `EXPIRED`
- `FAILED`

State transitions MUST be race-safe and idempotent.

### Task

```text
QUEUED → RUNNING → SUCCEEDED
                 ├→ FAILED
                 └→ CANCELLED
```

---

## 15. API requirements

See `docs/API.md`.

General:

- JSON REST for control plane.
- WebSocket for CDP relay.
- `/v1`.
- stable error codes.
- request IDs.
- idempotency support.
- OpenAPI generated from source schemas.
- SDK generated or hand-maintained from the same contracts.
- pagination cursor-based.
- timestamps RFC 3339 UTC.

---

## 16. Security requirements

Mandatory before public production use:

- tenant-scoped authorization,
- secret hashing/encryption,
- provider credentials server-side only,
- TLS everywhere,
- URL validation,
- SSRF protection,
- DNS rebinding defense,
- redirect revalidation,
- private-network blocking by default,
- rate limits,
- WebSocket limits,
- signed short-lived relay credentials,
- audit trail,
- artifact isolation,
- structured redaction,
- dependency scanning,
- SAST,
- container/runtime hardening.

---

## 17. Reliability requirements

### Target SLOs for GA design

These are engineering targets, not promises until measured in production.

#### Control plane availability
- target: 99.9% monthly

#### Routing decision
- target p99: < 25 ms inside SurfGate, excluding remote provider calls

#### API overhead
- target p95: < 150 ms for metadata-only operations, excluding provider allocation

#### Session cleanup
- expired sessions reconciled within 60 seconds under normal operation

#### Fallback
- no more than one automatic cross-runtime fallback in MVP unless policy explicitly permits a bounded sequence

#### Data integrity
- no session can transition from a terminal state back to active
- termination is idempotent

---

## 18. Performance and scale targets

Initial design targets:

- 1,000 concurrent relayed sessions without architectural changes
- horizontal relay scaling
- stateless API instances
- Redis-backed ephemeral registry
- Postgres durable state
- no single process owns irreplaceable session state

Scale testing must measure:
- connection count,
- frames/sec,
- bytes/sec,
- heap,
- event-loop delay,
- upstream disconnect recovery,
- Redis pressure,
- DB write amplification.

10,000+ concurrency is a later validation target, not an MVP acceptance gate.

---

## 19. Observability requirements

See `docs/OBSERVABILITY.md`.

Must answer:

- What runtime was chosen?
- Why?
- How long did routing take?
- How long did allocation take?
- Did fallback occur?
- Did fallback succeed?
- What stable error class occurred?
- Which provider is degraded?
- What is session duration?
- How many sessions are active?
- What is relay traffic volume?
- Are tenants hitting quota?
- What is estimated runtime cost?

No raw page content in normal logs.

---

## 20. Success metrics

Product:

- percentage of sessions successfully allocated,
- percentage of eligible workloads using Kitesurf fast path,
- fallback rescue rate,
- terminal failure rate after fallback,
- median/95p estimated runtime cost per successful task,
- developer integration time,
- provider diversity.

Engineering:

- control-plane SLO,
- provider allocation latency,
- routing latency,
- relay disconnect error rate,
- cleanup leak rate,
- conformance pass rate,
- security test pass rate.

Quality:

- zero cross-tenant access incidents,
- zero plaintext provider credential exposure,
- zero unbounded retry loops,
- stable API/error contract.

---

## 21. Acceptance criteria — MVP

MVP is complete when:

1. A client can create a provider-neutral session through SurfGate.
2. SurfGate can allocate Kitesurf through the Cloudflare Browser Run CDP path.
3. SurfGate can allocate Chromium.
4. A capability that Kitesurf does not support routes directly to Chromium.
5. An eligible, classified Kitesurf failure can fall back once to Chromium.
6. Client connects through a SurfGate-authenticated relay without seeing provider credentials.
7. Session termination closes the upstream resource.
8. Tenant A cannot access Tenant B sessions.
9. Private-network SSRF attempts are blocked by default.
10. Routing decisions have stable reason codes and traces.
11. Providers pass a shared conformance suite.
12. Unit/integration/security tests run in CI.
13. OpenAPI documentation is generated.
14. Core metrics and traces are emitted.
15. Local development works from documented commands.

---

## 22. Milestones

### Milestone 0 — Repository foundation
- monorepo
- contracts
- config
- lint/typecheck/test
- CI
- local Postgres/Redis
- repository engineering standards

### Milestone 1 — Provider core
- provider interface
- capability model
- normalized errors
- provider conformance harness

### Milestone 2 — Kitesurf and Chromium adapters
- Cloudflare Browser Run integration
- health probes
- allocation/termination
- live conformance job

### Milestone 3 — Deterministic router
- hard filters
- scoring
- reason codes
- fallback state machine
- decision persistence

### Milestone 4 — Session control plane
- tenant/API-key auth
- create/get/delete
- idempotency
- quota
- audit

### Milestone 5 — CDP relay
- signed relay token
- upstream credential isolation
- WebSocket backpressure
- lifecycle cleanup

### Milestone 6 — Managed task API
- extract
- screenshot
- PDF
- artifact storage

### Milestone 7 — Production hardening
- SSRF/DNS protections
- load tests
- chaos/provider failure tests
- dashboards/alerts
- retention jobs
- deployment runbooks

### Milestone 8 — Public developer experience
- TypeScript SDK
- examples
- CLI
- OpenAPI
- compatibility docs
- OSS release preparation

---

## 23. Risks

### R1. Kitesurf changes quickly
Mitigation:
- provider abstraction,
- explicit capabilities,
- live conformance probes,
- no Kitesurf-specific public contract.

### R2. CDP relay can become performance bottleneck
Mitigation:
- separate relay data plane,
- horizontal scaling,
- minimal parsing,
- backpressure,
- connection load tests.

### R3. Provider-specific errors are difficult to classify
Mitigation:
- normalized error taxonomy,
- preserve private upstream diagnostics,
- conformance tests.

### R4. SSRF / private-network access
Mitigation:
- default deny private networks,
- DNS/redirect validation,
- separate enterprise policy for intentional private access.

### R5. Logging leaks sensitive browser content
Mitigation:
- metadata-only telemetry,
- central redaction,
- opt-in bounded debugging.

### R6. Automated fallback causes duplicate side effects
Mitigation:
- fallback defaults are safer for allocation/session creation than arbitrary action replay,
- managed task API marks actions as read-only vs potentially mutating,
- no automatic replay of irreversible browser actions unless explicitly safe/idempotent.

---

## 24. Important product distinction: session fallback vs action fallback

SurfGate can safely retry **session allocation** more often than it can retry an arbitrary browser workflow.

Example:

```text
allocate Kitesurf → allocation fails → allocate Chromium
```

is usually safe.

But:

```text
click "Purchase" → unknown timeout → replay whole task in Chromium
```

may create duplicate side effects.

Therefore the task layer MUST classify operations:

- read-only,
- idempotent,
- potentially mutating,
- irreversible/unknown.

Automatic action replay is out of MVP unless safety is provable.

---

## 25. Future opportunities

- browser-provider marketplace,
- compatibility intelligence,
- domain-specific runtime recommendations,
- budget optimizer,
- cross-provider hedging for read-only tasks,
- agent browser evaluation suite,
- MCP server,
- policy-as-code,
- self-hosted control plane,
- private-network enterprise connector,
- per-task carbon/compute reporting,
- WASM/browser capability fingerprint registry.

---

## 26. Open questions

These should be resolved through ADRs during implementation:

1. Is Fastify the final HTTP/WebSocket framework?
2. Should relay and API deploy as separate processes from the first release?
3. BullMQ vs. Temporal for managed task durability?
4. Drizzle vs. Prisma vs. SQL-first database layer?
5. Exact relay token format: PASETO vs. JWT?
6. Should Cloudflare Browser Run Chromium be the only initial fallback or should local Chromium be first-class?
7. Which runtime cost signals are actually available from providers?
8. What artifact retention should OSS default to?
9. What capabilities can be automatically detected vs. statically declared?

None of these should block the provider-neutral contract.

---

## 27. References

- Cloudflare Kitesurf announcement: https://blog.cloudflare.com/kitesurf/
- Cloudflare Browser Run CDP: https://developers.cloudflare.com/browser-run/cdp/
- Cloudflare Browser Run + Playwright: https://developers.cloudflare.com/browser-run/cdp/playwright/
- Cloudflare Browser Run + Puppeteer: https://developers.cloudflare.com/browser-run/cdp/puppeteer/
- Cloudflare Browser Run HTTP session management: https://developers.cloudflare.com/browser-run/cdp/session-management/
- Cloudflare Browser Run limits: https://developers.cloudflare.com/browser-run/limits/
- Cloudflare Browser Run Playwright support: https://developers.cloudflare.com/browser-run/playwright/
