# Chromium Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Epic 3 as a bounded, credential-safe Cloudflare Browser Run Chromium provider that passes the exact shared provider conformance suite without regressing Kitesurf.

**Architecture:** `packages/config` remains the only environment boundary. A small private `packages/provider-cloudflare` package owns the genuinely shared Cloudflare Browser Run HTTP transport and provider lifecycle implementation; `provider-kitesurf` and `provider-chromium` supply runtime-specific profiles, capability declarations, and public factories without depending on one another. Chromium uses Cloudflare's current `/browser-rendering/devtools` namespace with no Kitesurf selector, while Kitesurf retains its explicit isolated selector. `provider-core` and `contracts` remain vendor-neutral and unchanged.

**Tech Stack:** Node.js 24, TypeScript 5.9 strict mode, pnpm workspaces, standard `fetch`, Zod 4, Vitest 3, Turbo.

## Global Constraints

- Implement only Epic 3; do not begin router, database, API, authentication, relay, or managed task work.
- Treat current official Cloudflare documentation as the runtime source of truth.
- Never print, serialize, log, or commit Cloudflare credentials, authorization headers, cookies, or secret-bearing CDP URLs.
- Every network operation must honor `AbortSignal` and finite `timeoutMs`; do not add retries.
- Keep the exact existing `runProviderConformanceSuite()` assertions unchanged.
- Run live provider tests only when both required Cloudflare variables are present and non-empty, and terminate every allocated session in `finally`.

---

### Task 1: Characterize Chromium and Shared Cloudflare Contracts

**Files:**

- Create: `packages/provider-chromium/test/fixtures.ts`
- Create: `packages/provider-chromium/test/test-transport.ts`
- Create: `packages/provider-chromium/test/chromium-browser-provider.test.ts`
- Create: `packages/provider-chromium/test/chromium-browser-provider.conformance.test.ts`
- Modify: `packages/provider-chromium/package.json`
- Replace: `packages/provider-chromium/tsconfig.json`
- Create: `packages/provider-chromium/tsconfig.build.json`

**Interfaces:**

- Consumes: `CloudflareConfig`, `BrowserProvider`, the provider-core schemas/errors, and the exact shared conformance suite.
- Produces: failing executable specifications for `ChromiumBrowserProvider`, `createChromiumBrowserProvider()`, and `CHROMIUM_CAPABILITIES`.

- [x] **Step 1: Add deterministic Chromium fixtures and sanitized scripted fetch**

Use a fixed account ID, fake token, UUID session ID, fixed clock, and responses containing only test data. Record the request method, URL, header names, and a boolean authorization check; never retain the header value.

- [x] **Step 2: Write the focused Chromium contract tests**

Cover not-configured health, descriptor validation, the full capability map, the default Chromium path with no `browser=kitesurf`, keep-alive clamping, clean authorization construction, response validation and WSS ownership checks, cancellation before/during requests, timeouts including response-body reads, 401/403/429/5xx/network/unknown normalization, bounded invalid-allocation cleanup, successful/idempotent/not-found termination, concurrent termination arbitration, termination timeout/5xx/malformed responses, and secret sanitization.

- [x] **Step 3: Bind Chromium to the exact shared conformance suite**

```ts
runProviderConformanceSuite({
  name: 'ChromiumBrowserProvider',
  createProvider: createChromiumConformanceProvider,
  allocateRequest: createChromiumAllocateRequest,
})
```

- [x] **Step 4: Run focused tests and confirm RED**

Run: `pnpm --filter @surfgate/provider-chromium test`
Expected: FAIL because the Chromium provider exports and implementation do not yet exist.

### Task 2: Extract the Private Shared Cloudflare Provider Layer

**Files:**

- Create: `packages/provider-cloudflare/package.json`
- Create: `packages/provider-cloudflare/tsconfig.json`
- Create: `packages/provider-cloudflare/tsconfig.build.json`
- Create: `packages/provider-cloudflare/src/index.ts`
- Move/Generalize: `packages/provider-kitesurf/src/cloudflare-transport.ts` to `packages/provider-cloudflare/src/cloudflare-browser-run-transport.ts`
- Create: `packages/provider-cloudflare/src/cloudflare-browser-run-provider.ts`
- Modify: `packages/provider-kitesurf/src/kitesurf-browser-provider.ts`
- Delete: `packages/provider-kitesurf/src/cloudflare-transport.ts`
- Modify: `packages/provider-kitesurf/package.json`

**Interfaces:**

- Consumes: `CloudflareConfig`, provider-core lifecycle contracts, and contracts capability evaluation.
- Produces: internal `CloudflareBrowserRunProvider` and immutable `CloudflareBrowserRunProfile`; no public/client-facing Cloudflare contract.

- [x] **Step 1: Move the bounded transport without changing behavior**

Preserve fixed `https://api.cloudflare.com` validation, header-only authentication, response-size bounds, composed timeout/cancellation, retry-after parsing, quota/capacity classification, request-ID-only diagnostics, and sanitized error mapping.

- [x] **Step 2: Generalize only proven shared lifecycle mechanics**

Parameterize the provider descriptor/profile, API namespace, optional browser selector, accepted clean WSS namespaces, keep-alive maximum, and optional absolute session-duration limit. Keep health, allocation validation/cleanup, capability filtering, and idempotent/concurrent termination behavior in one implementation.

- [x] **Step 3: Convert Kitesurf to a thin composition wrapper**

Retain its existing descriptor, explicit `browser=kitesurf`, conservative beta capability map, 10-minute duration limit, and accepted `browser-run`/legacy `browser-rendering` WSS responses. Do not change provider-core or contracts.

- [x] **Step 4: Run Kitesurf targeted and conformance tests**

Run: `pnpm --filter @surfgate/provider-kitesurf test`
Run: `pnpm --filter @surfgate/provider-kitesurf test:conformance`
Expected: PASS with no weakened assertions.

### Task 3: Implement Chromium Provider and Live Lifecycle

**Files:**

- Create: `packages/provider-chromium/src/chromium-browser-provider.ts`
- Modify: `packages/provider-chromium/src/index.ts`
- Create: `packages/provider-chromium/test/chromium-browser-provider.live.test.ts`
- Modify: `packages/provider-chromium/README.md`

**Interfaces:**

- Consumes: `CloudflareBrowserRunProvider`, Cloudflare config from `packages/config`, and the existing provider-neutral capability model.
- Produces: `ChromiumBrowserProvider implements BrowserProvider`, `createChromiumBrowserProvider(config, options?)`, and `CHROMIUM_CAPABILITIES`.

- [x] **Step 1: Declare an evidence-based Chromium capability map**

Mark documented CDP/Chromium and Browser Run product capabilities supported, mark video unsupported because Cloudflare explicitly lists Playwright video as incomplete, and keep downloads/uploads unknown where current product documentation does not make a reliable claim. Do not infer support merely from upstream Chromium.

- [x] **Step 2: Implement the Chromium profile and factory**

Use `/browser-rendering/devtools/browser`, omit the Kitesurf selector so stable Chromium is selected, clamp `keep_alive` to the documented inactivity window, permit longer absolute requested sessions because active sessions have no fixed lifetime, and accept only clean Cloudflare-owned standard namespace WSS URLs.

- [x] **Step 3: Run Chromium unit and exact conformance tests GREEN**

Run: `pnpm --filter @surfgate/provider-chromium test`
Run: `pnpm --filter @surfgate/provider-chromium test:conformance`
Expected: PASS.

- [x] **Step 4: Add and run the gated live test**

Allocate one Chromium session, validate the normalized session and runtime identity, optionally make only architecture-supported safe validation, and terminate in `finally`. Run: `pnpm --filter @surfgate/provider-chromium test:live`.

- [x] **Step 5: Re-run the gated Kitesurf live lifecycle**

Run: `pnpm --filter @surfgate/provider-kitesurf test:live` and report the result separately.

### Task 4: Documentation, ADR, and Repository Verification

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/PRD.md`
- Modify: `docs/ROUTING.md`
- Modify: `docs/IMPLEMENTATION_PLAN.md`
- Create: `docs/adr/0007-shared-cloudflare-browser-run-provider.md`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: implemented runtime semantics and official Cloudflare sources current on 2026-08-08.
- Produces: synchronized provider boundaries, capability comparison, current endpoint/lifetime/rate-limit semantics, live test commands, and an explicit shared-transport decision.

- [x] **Step 1: Document the verified current Chromium contract**

Record `/browser-rendering/devtools/browser`, bearer token authentication with Browser Rendering Edit, POST creation and DELETE close semantics, the 60-second default/up-to-10-minute documented inactivity window, active-session lifetime semantics, Free/Paid concurrency and acquisition limits, stable Chromium default selection, and material Kitesurf differences.

- [x] **Step 2: Document the shared internal Cloudflare boundary**

The ADR must explain why two Cloudflare adapters share transport/lifecycle mechanics while provider-core and contracts remain vendor-neutral, and why provider-specific profiles/capabilities remain in their own packages.

- [x] **Step 3: Format and run focused checks**

Run: `pnpm format`
Run focused lint, typecheck, test, and build for `provider-cloudflare`, `provider-kitesurf`, and `provider-chromium`.

- [x] **Step 4: Run all repository gates**

Run: `pnpm format:check`
Run: `pnpm lint`
Run: `pnpm typecheck`
Run: `pnpm test`
Run: `pnpm build`
Run: `pnpm check`

- [x] **Step 5: Review the full diff and security boundaries**

Search for provider-to-provider dependencies, Cloudflare leakage into core/contracts, direct `process.env` outside config, `any`, token/header/cookie values, secret-bearing URLs, raw upstream bodies, inaccurate capabilities, unbounded fetches/retries, missing cleanup, non-idempotent termination, swallowed errors, and unrelated changes. Resolve every P0/P1 finding before completion.
