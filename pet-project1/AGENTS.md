# AGENTS.md — SurfGate Engineering Contract

This file is the canonical instruction set for coding agents working in the SurfGate repository.

SurfGate is a production-oriented browser runtime router for AI agents. It brokers browser sessions and tasks across heterogeneous runtimes, initially Cloudflare Kitesurf and Chromium, behind a provider-neutral API.

Treat this repository as infrastructure software with security, reliability, compatibility, and observability requirements. Do not treat it as a demo.

---

## 1. Prime directives

When modifying SurfGate:

1. **Preserve provider neutrality.**
   - Public contracts MUST NOT expose Kitesurf-only or Chromium-only concepts unless they are explicitly namespaced as optional provider extensions.
   - Generic capabilities belong in `packages/contracts`.
   - Vendor mechanics belong inside provider adapters.

2. **Do not bypass architectural boundaries to make a test pass.**
   - Fix the correct layer.
   - If an abstraction is wrong, update the abstraction deliberately and document the decision.

3. **Do not perform drive-by refactors.**
   - Change only what is required for the task.
   - Do not rename unrelated files, reformat the whole repository, swap libraries, or change architecture without an explicit requirement.

4. **Security failures must fail closed.**
   - Unknown URLs, invalid policies, unverified redirects, unsupported protocols, expired tokens, and ambiguous authorization MUST be rejected rather than guessed through.

5. **Never expose provider credentials to clients.**
   - Cloudflare API tokens, upstream CDP authorization headers, database credentials, signing keys, and storage credentials MUST remain server-side.

6. **Every routing decision must be explainable.**
   - A decision MUST emit a machine-readable reason code.
   - A fallback MUST record the original choice, failure class, fallback choice, and final outcome.

7. **Do not silently weaken validation, types, tests, security controls, or telemetry.**

8. **No anti-bot evasion features.**
   - Do not add stealth plugins, TLS fingerprint spoofing, CAPTCHA bypass, challenge circumvention, or mechanisms intended to evade site protections.
   - SurfGate may detect incompatibility and route to a supported runtime, but it does not defeat access controls.

9. **Do not assume Kitesurf feature parity with Chromium.**
   - Kitesurf is currently a partial CDP implementation.
   - Capabilities must be represented explicitly and tested.

10. **Verify before claiming completion.**
    - Run the relevant checks.
    - State what was run.
    - If a check cannot be run, say why.

---

## 2. Read before coding

For any non-trivial task, read the relevant documents first:

- `docs/PRD.md` — product behavior and scope
- `docs/ARCHITECTURE.md` — service and package boundaries
- `docs/API.md` — public API contract
- `docs/ROUTING.md` — routing rules and fallback behavior
- `docs/SECURITY.md` — security invariants
- `docs/THREAT_MODEL.md` — attacker model
- `docs/OBSERVABILITY.md` — logs, metrics, traces
- `docs/TESTING.md` — required tests
- `docs/IMPLEMENTATION_PLAN.md` — implementation sequence

When implementation conflicts with a document, do not silently choose one. Determine whether the implementation or documentation is stale and update the correct source of truth.

---

## 3. Repository architecture

Expected structure:

```text
apps/
  api/                  HTTP control plane and session creation
  relay/                authenticated WebSocket/CDP relay
  worker/               managed asynchronous task execution

packages/
  contracts/            external/public types and schemas
  config/               environment/config parsing and validation
  router/               runtime selection and fallback state machine
  provider-core/        provider interfaces and capability model
  provider-kitesurf/    Cloudflare Kitesurf adapter
  provider-chromium/    Chromium adapter
  security/             URL, policy, egress, token, redaction helpers
  observability/        OpenTelemetry and structured logging helpers
  testing/              provider conformance and fixtures
```

### Dependency direction

Allowed direction:

```text
apps
  ↓
domain packages
  ↓
provider-core / contracts
  ↓
shared primitives
```

Provider implementations MUST depend on `provider-core`, not on each other.

The router MUST NOT import concrete provider implementation classes. Runtime instances are injected through interfaces.

The public contracts package MUST NOT import API framework, database ORM, Redis client, Cloudflare SDK, Playwright, or Puppeteer.

---

## 4. Build and development commands

The intended package manager is pnpm.

Expected root commands:

```bash
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:conformance
pnpm format:check
pnpm build
pnpm check
```

`pnpm check` MUST eventually run the minimum merge gate:

```text
format:check
lint
typecheck
unit tests
build
```

Integration and provider conformance tests may require explicit environment credentials and therefore can be separate CI jobs.

When changing a single package, prefer filtered commands while iterating, but run repository-level checks before declaring the task complete if practical.

---

## 5. TypeScript rules

Use TypeScript for production code.

Required compiler posture:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noImplicitOverride: true`
- `useUnknownInCatchVariables: true`

Rules:

- Do not use `any` in production code.
- Do not use `@ts-ignore`.
- Use `@ts-expect-error` only in a test proving a compile-time constraint and include a reason.
- Prefer `unknown` at trust boundaries and refine using schemas/type guards.
- External payloads MUST be runtime validated.
- Prefer discriminated unions for state machines.
- Prefer immutable data structures for routing inputs and decisions.
- Public IDs are opaque strings; do not encode business meaning into their shape.
- Use UTC for timestamps.
- Store timestamps as timezone-aware database values.
- Use monotonic timers for elapsed durations where available.

Naming:

- `URL`, `HTTP`, `API`, `CDP`, `ID`, `TLS` remain uppercase inside PascalCase names where natural.
- Types/interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE` for true constants
- Files: `kebab-case.ts`
- Tests: `*.test.ts` for unit tests, `*.integration.test.ts`, `*.conformance.test.ts`

---

## 6. API and schema discipline

All public request/response shapes MUST originate from versioned schemas in `packages/contracts`.

Do not hand-write slightly different types in multiple services.

Every endpoint must define:

- request schema
- response schema
- error schema
- auth requirement
- idempotency semantics
- rate-limit behavior
- audit event
- telemetry span name
- timeout semantics

Breaking public API changes require either:

- a new API version, or
- an explicit migration plan and ADR before implementation.

Errors are stable machine-readable objects, not arbitrary strings.

Expected shape:

```json
{
  "error": {
    "code": "ROUTING_NO_COMPATIBLE_RUNTIME",
    "message": "No runtime satisfies the requested capabilities.",
    "requestId": "req_...",
    "details": {}
  }
}
```

Do not leak stack traces, upstream credentials, raw provider responses containing secrets, or internal hostnames to external clients.

---

## 7. Routing-engine rules

Routing has two stages.

### Stage A: hard capability filtering

A runtime is ineligible if it cannot satisfy a required capability.

Examples:

- `requiresWebGL=true` excludes a runtime that does not support WebGL.
- `requiresPersistentAuth=true` can exclude ephemeral runtimes that cannot meet the requested duration/state semantics.
- explicit tenant policy can exclude a provider.
- runtime health can exclude an unhealthy provider.

Hard constraints are NEVER overridden by a score.

### Stage B: deterministic scoring

Eligible candidates may be scored using:

- tenant preference
- estimated cost
- provider health
- historical success for the target domain/task class
- latency profile
- capacity pressure
- explicit runtime preference

The first release MUST use deterministic rules/weights. Do not introduce LLM-based routing or online ML into the critical path.

Every decision returns:

```text
selectedRuntime
eligibleCandidates
rejectedCandidates
reasonCodes
scoreBreakdown
policyVersion
```

Routing changes require tests covering:
- positive selection
- rejected candidate reason
- tie-breaking
- unknown capability
- provider degradation
- fallback
- tenant override
- deterministic replay

---

## 8. Fallback state machine

Fallback must be bounded.

Never create an unbounded retry loop between providers.

Recommended shape:

```text
REQUESTED
  ↓
ROUTED
  ↓
ALLOCATING
  ├── success → ACTIVE
  └── classified failure
         ↓
      FALLBACK_ELIGIBLE?
         ├── no → FAILED
         └── yes
              ↓
         FALLBACK_ALLOCATING
              ├── success → ACTIVE
              └── failure → FAILED
```

Retries must distinguish:
- transient infrastructure failures
- capability incompatibility
- authorization failures
- policy denials
- client errors
- upstream rate limits
- unknown errors

Do not retry permanent failures blindly.

---

## 9. Provider adapter contract

Every runtime provider MUST implement the same provider interface and conformance suite.

A provider implementation is responsible for:

- declaring capabilities
- reporting health
- allocating a session
- terminating a session
- mapping upstream errors to SurfGate error classes
- reporting provider metadata
- never leaking credentials
- respecting timeouts and cancellation

Provider-specific code MUST NOT contain global routing policy.

Kitesurf-specific concerns stay in `provider-kitesurf`.
Chromium-specific concerns stay in `provider-chromium`.

When Cloudflare changes Kitesurf behavior, update:
1. the capability declaration,
2. conformance tests,
3. compatibility documentation,
4. routing tests if required.

---

## 10. WebSocket/CDP relay rules

Treat CDP as a privileged control channel.

The relay must:

- authenticate the client before connecting upstream
- authorize access to the specific session
- enforce session expiry
- enforce frame/message size limits
- enforce idle and absolute timeouts
- close upstream when the client session is revoked
- reject connections to terminated sessions
- correlate relay spans with session/request IDs
- redact sensitive payload data from logs
- apply backpressure
- bound buffers
- clean up both sides on disconnect

Do not persist raw CDP traffic by default.

Full protocol capture may only exist behind an explicit debugging feature with:
- tenant opt-in,
- short retention,
- encryption,
- redaction,
- access auditing.

---

## 11. Security invariants

Browser requests are untrusted input.

### URL and network controls

Default supported schemes:
- `https`
- `http`

Reject by default:
- `file:`
- `data:` unless a specific internal feature requires it
- `javascript:`
- `ftp:`
- arbitrary custom schemes

Protect against SSRF and DNS rebinding.

Unless a tenant explicitly configures a private-network policy, block:
- loopback
- RFC1918 private ranges
- link-local ranges
- cloud metadata endpoints
- IPv6 local/link-local/private ranges
- internal service DNS suffixes

Validate every redirect target, not only the initial URL.

### Secrets

- Never log tokens or authorization headers.
- Never put secrets in URLs.
- Never commit `.env` files.
- Use secret managers/KMS in production.
- Use short-lived SurfGate session tokens.
- Rotate signing keys.

### Multi-tenancy

Every durable record must be tenant-scoped.
Every lookup must include tenant scope or be performed through an abstraction that enforces it.

Tests must prove that one tenant cannot:
- fetch another tenant's session,
- connect to another tenant's relay,
- read another tenant's artifacts,
- access another tenant's audit records.

---

## 12. Observability requirements

Every externally visible operation must have:

- request ID
- tenant ID in internal context
- trace ID
- operation name
- latency
- outcome
- stable error code when failed

Do not put high-cardinality uncontrolled values such as raw URLs into metric labels.

Use structured logs.

Expected top-level events include:

- `session.create.requested`
- `routing.decision`
- `provider.allocate.started`
- `provider.allocate.completed`
- `provider.allocate.failed`
- `routing.fallback.started`
- `relay.connected`
- `relay.disconnected`
- `session.terminated`
- `policy.denied`

Sensitive fields must be redacted at the logger boundary, not ad hoc at call sites.

---

## 13. Testing standard

A change is not complete without appropriate tests.

### Unit tests

Required for:
- routing rules
- capability evaluation
- error mapping
- auth decisions
- URL/policy validation
- config validation
- redaction
- token expiry
- timeout logic

### Integration tests

Required for:
- API + Postgres
- API + Redis
- session state transitions
- relay auth
- task execution
- artifact storage

### Provider conformance tests

Every provider runs the same behavioral suite.

A provider cannot be marked production-capable unless required conformance tests pass.

Tests must not depend on arbitrary public websites when a local deterministic fixture can prove the behavior.

Use external live-site tests only as separate compatibility probes.

### Security tests

Include:
- SSRF attempts
- DNS rebinding simulation where feasible
- malicious redirects
- cross-tenant access
- expired/replayed tokens
- oversized WebSocket frames
- malformed CDP messages
- secrets in upstream error responses
- rate-limit bypass attempts

---

## 14. Database and migration rules

Schema changes require migrations.

Never edit a deployed migration.

Every migration must be:
- deterministic
- forward-safe
- reviewed for lock/availability impact
- tested against representative data when it changes large tables

Use application-level enums carefully; prefer text + validation where deployment ordering could otherwise break rolling releases.

Session state transitions should use compare-and-set or transactional semantics to prevent conflicting terminal states.

---

## 15. Configuration rules

All config must be validated at process startup.

No direct `process.env.*` access outside the config package.

When adding configuration:
1. update schema,
2. update `.env.example`,
3. update deployment docs,
4. add validation test,
5. document default and security implications.

Production services must fail at startup when required secure configuration is missing.

---

## 16. Dependency policy

Before adding a runtime dependency:

- verify the capability is not already available in the standard library or current stack,
- prefer maintained libraries with clear ownership,
- avoid packages with large transitive trees for trivial helpers,
- document why the dependency is needed,
- pin or range versions according to repository policy,
- update lockfile,
- run security/dependency checks.

Do not add multiple libraries that solve the same concern without an ADR.

---

## 17. Documentation discipline

Update docs in the same change when behavior changes.

Specifically:

- API change → `docs/API.md`
- routing change → `docs/ROUTING.md`
- architecture boundary → `docs/ARCHITECTURE.md` + ADR
- security control → `docs/SECURITY.md` / `docs/THREAT_MODEL.md`
- new metric → `docs/OBSERVABILITY.md`
- new test class → `docs/TESTING.md`
- configuration → `.env.example` + operations docs

Do not let comments become the only documentation for a public behavior.

---

## 18. Git and PR behavior

Before editing:
- inspect current branch,
- inspect working tree,
- do not destroy unrelated uncommitted changes.

Never:
- force push `main`,
- rewrite unrelated history,
- delete user work,
- commit secrets,
- make large formatting-only changes unless asked.

Preferred commit format:

```text
<type>(<scope>): <imperative summary>
```

Examples:

```text
feat(router): add capability-based runtime filtering
fix(relay): close upstream on token revocation
test(security): cover redirect SSRF policy
docs(api): define idempotent session creation
```

PRs should describe:
- problem
- implementation
- security impact
- observability impact
- tests run
- migration/deployment impact

---

## 19. Agent workflow for implementation tasks

For a non-trivial change:

1. **Understand**
   - Read relevant specs and existing code.
   - Identify affected boundaries.

2. **Plan**
   - State the minimum files/layers that need to change.
   - Identify risks.
   - Identify tests before coding.

3. **Implement**
   - Make the smallest coherent change.
   - Preserve existing public behavior unless changing it is the task.

4. **Verify locally**
   - Run focused tests first.
   - Run lint/typecheck.
   - Run broader checks appropriate to the change.

5. **Review your own diff**
   - Look for secrets.
   - Look for accidental API changes.
   - Look for missing cleanup/timeouts.
   - Look for logging of sensitive data.
   - Look for tests that only assert implementation details.

6. **Update docs**
   - Keep sources of truth synchronized.

7. **Report**
   - Summarize changes.
   - List checks run.
   - State unresolved risks or follow-ups.

---

## 20. Definition of done

A production code change is done only when:

- requirements are satisfied,
- typecheck passes,
- lint passes,
- appropriate tests pass,
- security invariants still hold,
- telemetry exists for new operational behavior,
- errors use stable codes,
- cleanup/cancellation is handled,
- documentation is updated,
- no secrets are present,
- diff contains no unrelated changes.

For provider or routing changes, also require:
- provider conformance coverage,
- routing decision tests,
- fallback behavior tests,
- reason-code verification.

If any item is intentionally skipped, explicitly state the reason.
