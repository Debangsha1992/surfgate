# Provider Core and Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement SG-0103 through SG-0105 as a provider-neutral, cancellation-aware browser-provider abstraction with a deterministic fake and one reusable behavioral conformance suite.

**Architecture:** `@surfgate/provider-core` owns runtime-validated internal provider descriptors, health, allocation/session, termination, operation, and normalized-error contracts. `@surfgate/testing` depends on those contracts to provide a configurable in-memory fake and a scenario-driven Vitest suite; concrete providers later supply scenario harnesses without changing the suite.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9 strict mode, pnpm workspaces, Zod 4, Vitest 3, Turbo.

## Global Constraints

- Scope only SG-0103, SG-0104, and SG-0105; do not begin SG-0201 or concrete providers.
- Reuse `CapabilitySupportMapSchema` and `CapabilityRequirementsSchema` from `@surfgate/contracts`; do not create another capability enum.
- `@surfgate/provider-core` must not depend on concrete providers, Fastify, PostgreSQL, Redis, Cloudflare SDKs, Playwright, or Puppeteer.
- Every asynchronous provider lifecycle operation requires a finite `timeoutMs` and accepts an optional `AbortSignal`.
- Provider termination is idempotent: an already-terminated or absent upstream session resolves to `already_terminated`.
- Unknown and secret-bearing upstream failures become canonical normalized provider errors without preserving raw values.
- Tests use fake timers or controlled abort signals; no real network and no arbitrary wall-clock sleeps.

---

### Task 1: Provider-core schemas and interface

**Files:**

- Create: `packages/provider-core/test/provider-contracts.test.ts`
- Create: `packages/provider-core/src/provider-descriptor.ts`
- Create: `packages/provider-core/src/provider-health.ts`
- Create: `packages/provider-core/src/provider-lifecycle.ts`
- Create: `packages/provider-core/src/provider-error.ts`
- Create: `packages/provider-core/src/browser-provider.ts`
- Modify: `packages/provider-core/src/index.ts`
- Modify: `packages/provider-core/package.json`
- Modify: `packages/provider-core/tsconfig.json`
- Create: `packages/provider-core/tsconfig.build.json`

**Interfaces:**

- Consumes: `CapabilitySupportMapSchema`, `CapabilityRequirementsSchema`, `RequestIDSchema`, and their inferred types from `@surfgate/contracts`.
- Produces: `ProviderDescriptor`, `ProviderHealth`, `ProviderAllocateRequest`, `ProviderSession`, `ProviderSessionRef`, `ProviderTerminationResult`, `ProviderOperationOptions`, `ProviderError`, `normalizeProviderError()`, and `BrowserProvider`.

- [x] **Step 1: Write failing schema/interface tests** covering a valid descriptor, incomplete/invalid capabilities, normalized configured/unconfigured health, safe allocation/session data, finite timeout options, idempotent termination result shapes, every provider error code, unknown thrown values, aborted signals, and secret-bearing error sanitization.
- [x] **Step 2: Run `pnpm --filter @surfgate/provider-core test`** and verify failure because the provider-core exports do not exist.
- [x] **Step 3: Implement descriptor and identity schemas.** Provider IDs and runtime classes use generic lowercase slug brands; descriptors contain only `providerID`, `runtimeClass`, `displayName`, exhaustive `capabilities`, fixed implementation name/version, optional region/config profile, and `configured`.
- [x] **Step 4: Implement health schemas.** Valid combinations are configured `healthy`, `degraded`, or `unavailable`, plus unconfigured `unavailable`; each includes an ISO UTC `checkedAt`, stable diagnostic code, capacity signal, and optional non-negative latency/retry delay.
- [x] **Step 5: Implement lifecycle schemas.** Allocation requests contain request ID, runtime class, requirements, experimental flag, bounded duration, optional HTTP(S) target, region/profile, and strict provider-safe correlation metadata. Provider sessions contain an internal reference, websocket connection metadata with only an opaque credential reference, allocation/expiry timestamps, and strict fixed metadata.
- [x] **Step 6: Implement explicit operation options and interface.** `health`, `allocate`, and `terminate` receive `{ timeoutMs, signal? }`; termination returns `terminated` or `already_terminated` instead of throwing for missing sessions.
- [x] **Step 7: Implement normalized errors.** Use stable codes for configuration, authorization, aborted, timeout, rate/capacity, transient upstream, unsupported, connection, invalid response, termination, and unknown failures. Canonical messages and strict serialized fields prevent raw upstream values from escaping.
- [x] **Step 8: Run focused provider-core test, typecheck, lint, and build** and verify all pass.

### Task 2: Deterministic fake provider

**Files:**

- Create: `packages/testing/test/fake-browser-provider.test.ts`
- Create: `packages/testing/src/fake-browser-provider.ts`
- Create: `packages/testing/src/fixtures.ts`
- Modify: `packages/testing/src/index.ts`
- Modify: `packages/testing/package.json`
- Modify: `packages/testing/tsconfig.json`

**Interfaces:**

- Consumes: all `BrowserProvider` lifecycle contracts and normalization helpers from `@surfgate/provider-core`.
- Produces: `FakeBrowserProvider`, `FakeBrowserProviderConfig`, deterministic provider/request fixtures, and declarative health/allocation/termination behaviors.

- [x] **Step 1: Write failing fake-provider tests** for healthy/degraded/unavailable/unconfigured health, successful delayed allocation, pre-abort, in-flight abort, timeout, rate-limit/transient/unsupported/connection/unknown failures, successful termination, double/nonexistent termination, termination failure, and invalid descriptor/capability rejection.
- [x] **Step 2: Run `pnpm --filter @surfgate/testing test -- fake-browser-provider`** and verify failure because the fake provider does not exist.
- [x] **Step 3: Implement immutable deterministic fixtures** with a complete capability map, fixed timestamps, safe metadata, and no credential-shaped values.
- [x] **Step 4: Implement bounded fake operations** using fake-timer-compatible `setTimeout`, one timeout timer per operation, immediate/in-flight AbortSignal handling, and listener/timer cleanup on every settlement path.
- [x] **Step 5: Implement declarative outcomes and state.** Allocation IDs use a deterministic counter; active references are held in a private set; repeated or unknown termination returns `already_terminated`; configured error outcomes throw only normalized `ProviderError` objects.
- [x] **Step 6: Run focused testing-package tests, typecheck, lint, and build** and verify all pass.

### Task 3: Reusable provider conformance suite

**Files:**

- Create: `packages/testing/src/provider-conformance.ts`
- Create: `packages/testing/test/fake-browser-provider.conformance.test.ts`
- Modify: `packages/testing/src/index.ts`
- Modify: `packages/testing/package.json`

**Interfaces:**

- Consumes: `BrowserProvider`, provider schemas/error helpers, and fake-provider scenario factories.
- Produces: `runProviderConformanceSuite({ name, createProvider, allocateRequest })`, where `createProvider(scenario)` supports the documented normalized health/allocation/termination scenarios.

- [x] **Step 1: Write the fake provider's conformance invocation** before creating the shared suite and verify it fails because `runProviderConformanceSuite` is missing.
- [x] **Step 2: Implement descriptor/health conformance cases** for schema validity, stable identity, exhaustive capabilities, configured/unconfigured states, normalized health failures, and absence of secret-shaped fields.
- [x] **Step 3: Implement allocation conformance cases** for valid sessions, pre/in-flight cancellation, timeout, configuration/authorization/rate/transient failures, unknown errors, and secret-bearing upstream error sanitization.
- [x] **Step 4: Implement termination conformance cases** for success, double/nonexistent idempotency, cancellation, timeout, normalized failure, and unknown failure.
- [x] **Step 5: Add `test:conformance`** to `@surfgate/testing` and run `pnpm --filter @surfgate/testing test:conformance`; verify the fake passes the exact exported suite.

### Task 4: Documentation and repository verification

**Files:**

- Modify: `packages/provider-core/README.md`
- Modify: `packages/testing/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TESTING.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: the finalized code and tested lifecycle semantics.
- Produces: synchronized architecture/testing guidance and root formatting coverage for all edited Markdown.

- [x] **Step 1: Document the exact provider interface**, internal-only session connection boundary, finite operation contract, normalized error taxonomy, and idempotent termination behavior.
- [x] **Step 2: Document the conformance harness** and its scenario-factory obligations; note that the fake runs it with no network.
- [x] **Step 3: Run `pnpm install`** to update workspace links and the lockfile.
- [x] **Step 4: Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check`, and the dedicated conformance command.**
- [x] **Step 5: Audit the final source** for concrete-provider imports, duplicate capability types, credentials, `any`, unbounded timers/promises, non-idempotent termination, implementation-coupled tests, and unrelated edits.
- [x] **Step 6: Request independent code review**, resolve all scoped important findings with regression tests, rerun every gate, and stop before SG-0201.
