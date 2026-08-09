# Deterministic Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement SG-0401 through SG-0407 as deterministic, explainable, provider-neutral domain logic in `packages/router`.

**Architecture:** The router receives already-collected provider descriptors, health snapshots, policy, and normalized optional signals. It builds stable candidates, applies hard eligibility before scoring, returns a runtime-validated persistence-ready decision, and exposes a separate bounded fallback reducer. It never imports concrete providers, performs I/O, or persists data.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest 3, pnpm workspaces, Turbo.

## Global Constraints

- Preserve `@surfgate/contracts` as the capability-schema source and `@surfgate/provider-core` as the descriptor/health/error source.
- Do not import concrete provider packages, Cloudflare, Fastify, PostgreSQL, Redis, Playwright, or Puppeteer.
- Do not make network calls or allocate sessions.
- Hard requirements, policy denial, unavailable health, exhausted capacity, and product-safety denial are never score inputs.
- Use the immutable `router-v1` weights and deterministic signal defaults from one policy module.
- Maximum automatic cross-runtime fallback count is exactly one.
- Validate external/domain boundaries at runtime and do not use `any` or `@ts-ignore`.

---

### Task 1: Candidate, input, policy, and reason schemas

**Files:**

- Create: `packages/router/src/candidate.ts`
- Create: `packages/router/src/reason-code.ts`
- Create: `packages/router/src/routing-input.ts`
- Create: `packages/router/test/fixtures.ts`
- Create: `packages/router/test/candidate.test.ts`
- Modify: `packages/router/package.json`
- Modify: `packages/router/tsconfig.json`

**Interfaces:**

- Consumes: `ProviderDescriptorSchema`, `ProviderHealthSchema`, capability and runtime schemas.
- Produces: `buildRoutingCandidates()`, `RoutingCandidateSchema`, `RoutingInputSchema`, `TenantRoutingPolicySchema`, `RoutingReasonCodeSchema`.

- [x] **Step 1: Write candidate and boundary tests**

  Test deterministic candidate IDs, input-order-independent sorting, duplicate rejection, strict schemas, policy defaults, safe normalized signals, and every stable reason code.

- [x] **Step 2: Run tests and verify RED**

  Run: `pnpm --filter @surfgate/router test`

  Expected: failure because the router exports do not exist.

- [x] **Step 3: Implement the schemas and builder**

  Candidate identity is `providerID/runtimeClass/region/configProfile`, with missing optional components represented distinctly and present components percent-encoded. Inputs include fixed IDs/timestamp, capability requirements, runtime selection, duration, tenant policy, candidate sources, and optional compatibility/efficiency/latency signals. Cross-field validation rejects duplicate candidate identities, duplicate signal identities, and signals for unknown candidates.

- [x] **Step 4: Run candidate tests and verify GREEN**

  Run: `pnpm --filter @surfgate/router test`

  Expected: candidate/input/reason tests pass.

---

### Task 2: Hard eligibility and versioned scoring

**Files:**

- Create: `packages/router/src/policy-v1.ts`
- Create: `packages/router/src/eligibility.ts`
- Create: `packages/router/src/scoring.ts`
- Create: `packages/router/test/eligibility.test.ts`
- Create: `packages/router/test/scoring.test.ts`

**Interfaces:**

- Consumes: validated `RoutingInput`, stable candidates, capability matcher, provider health.
- Produces: `evaluateCandidateEligibility()` and `scoreEligibleCandidate()`.

- [x] **Step 1: Write hard-filter and scoring tests**

  Cover supported/unsupported/unknown/experimental requirements, strict runtime preference without fallback, provider/runtime policy, configured state, degraded/unavailable health, capacity exhaustion, maximum duration, product safety, preferred capability scoring, signal defaults, degraded penalty, and exact weighted totals.

- [x] **Step 2: Run focused tests and verify RED**

  Run: `pnpm --filter @surfgate/router test`

  Expected: missing eligibility/scoring implementations.

- [x] **Step 3: Implement immutable `router-v1` policy**

  Use weights totaling 100: preference 30, efficiency 25, compatibility 20, health 15, latency 5, capacity 5. Defaults are explicit: unknown signal 50, Kitesurf efficiency 100, Chromium efficiency 60, unknown runtime efficiency 50, healthy 100, degraded 50, and capacity available/constrained/unknown scores 100/25/50. Preferred-capability support is folded deterministically into compatibility; it never rejects.

- [x] **Step 4: Implement hard eligibility before scoring**

  Return all stable rejection reasons. Required unsupported/unknown/experimental-without-opt-in, policy denial, unavailable/unconfigured, disallowed degraded, exhausted capacity, excessive duration, strict requested runtime, and safety blocks all reject before scoring.

- [x] **Step 5: Run focused tests and verify GREEN**

  Run: `pnpm --filter @surfgate/router test`

  Expected: all eligibility and scoring tests pass.

---

### Task 3: Persistence-ready decision and deterministic selection

**Files:**

- Create: `packages/router/src/routing-decision.ts`
- Create: `packages/router/src/router.ts`
- Create: `packages/router/test/routing.golden.test.ts`
- Create: `packages/router/test/invariants.test.ts`
- Modify: `packages/router/src/index.ts`
- Modify: `packages/router/README.md`

**Interfaces:**

- Consumes: validated input, eligibility results, scored candidates, `router-v1`.
- Produces: `routeBrowserRuntime()`, `RoutingDecisionSchema`, serializable eligible/rejected explanations and health snapshots.

- [x] **Step 1: Write the 19 selection golden cases and invariants**

  Cover fast path, hard WebGL/video/persistent-auth constraints, health, policy, explicit preference, experimental and unknown support, preferred support, stable ties, replay, and no-compatible outcomes. Assert rejected candidates are never selected and hard filters cannot be overridden by score.

- [x] **Step 2: Run golden tests and verify RED**

  Run: `pnpm --filter @surfgate/router test`

  Expected: missing selection and decision implementation.

- [x] **Step 3: Implement stable selection and decision schema**

  Sort by total score descending, preference score descending, efficiency score descending, then candidate ID ascending. Attach `LOWER_SCORE` or `STABLE_TIE_BREAK`, a stable selected reason, policy/capability versions, fixed input IDs/timestamp, candidate explanations, health snapshots, and an effective fallback policy. Return `selectedCandidate: null` plus `NO_COMPATIBLE_RUNTIME` when empty.

- [x] **Step 4: Run golden tests and verify GREEN**

  Run: `pnpm --filter @surfgate/router test`

  Expected: golden and invariant suites pass with deterministic output.

---

### Task 4: Bounded fallback classifier and state model

**Files:**

- Create: `packages/router/src/fallback.ts`
- Create: `packages/router/test/fallback.test.ts`
- Modify: `packages/router/src/index.ts`

**Interfaces:**

- Consumes: stable provider-core error codes or normalized fallback failure classes.
- Produces: `classifyProviderErrorForFallback()`, `classifyFallbackFailure()`, `createFallbackState()`, `transitionFallbackState()`, and runtime-validated state/event schemas.

- [x] **Step 1: Write fallback classification and reducer tests**

  Cover transient, timeout, rate/capacity, connection, pre-side-effect incompatibility, authorization, invalid request, policy/security, quota, no-compatible, malformed, canceled, unknown, successful primary allocation, one fallback success/failure, and rejection of a second fallback or repeated runtime.

- [x] **Step 2: Run fallback tests and verify RED**

  Run: `pnpm --filter @surfgate/router test`

  Expected: fallback exports are absent.

- [x] **Step 3: Implement pure bounded classification and state transitions**

  Allow only primary allocation failures classified safe before action replay. Model requested, routed, allocating, fallback-routed, fallback-allocating, active, and failed states. The reducer never allocates, retries, or performs I/O, and never permits more than one cross-runtime fallback.

- [x] **Step 4: Run fallback tests and verify GREEN**

  Run: `pnpm --filter @surfgate/router test`

  Expected: all fallback cases and invariants pass.

---

### Task 5: Documentation, regression, and review

**Files:**

- Modify: `docs/ROUTING.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/IMPLEMENTATION_PLAN.md`
- Create: `docs/adr/0008-router-v1-domain-model.md`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: completed domain behavior.
- Produces: synchronized v1 policy, persistence sequencing, fallback semantics, and test commands.

- [x] **Step 1: Document exact behavior and persistence sequencing**

  Record the weights/defaults/tie-break, strict preference semantics, reason codes, persistence-ready decision without ORM, fallback safety boundary, and provider-neutral dependency rule. Mark SG-0401 through SG-0407 complete only after verification.

- [x] **Step 2: Run focused quality checks**

  Run: `pnpm --filter @surfgate/router lint && pnpm --filter @surfgate/router typecheck && pnpm --filter @surfgate/router test && pnpm --filter @surfgate/router build`

- [x] **Step 3: Run explicit provider regression suites**

  Run the fake, Kitesurf, and Chromium `test:conformance` commands. Live credentials are not used.

- [x] **Step 4: Run repository merge gate**

  Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check`

- [x] **Step 5: Review boundaries and security invariants**

  Scan router source for concrete providers, Cloudflare, fetch/network, database/Redis/ORM, `any`, `@ts-ignore`, random selection, and environment reads. Request an independent code review and fix every Critical/Important issue before reporting.
