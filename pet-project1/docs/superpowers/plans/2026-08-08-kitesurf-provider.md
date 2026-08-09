# Kitesurf Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement SG-0201 through SG-0206 as a bounded, credential-safe Cloudflare Browser Run Kitesurf provider with deterministic and gated live conformance coverage.

**Architecture:** `packages/config` remains the only environment boundary and passes an optional Cloudflare Browser Run credential pair into `KitesurfBrowserProvider`. The provider uses injected standard `fetch` transport for deterministic tests, calls the current `/browser-run/devtools` HTTP lifecycle with `browser=kitesurf`, returns only validated internal provider-core sessions, and keeps tokens solely in request headers. The existing provider-core and shared conformance contract remain unchanged.

**Tech Stack:** Node.js 24, TypeScript 5.9 strict mode, pnpm workspaces, standard `fetch`, Zod 4, Vitest 3, Turbo.

## Global Constraints

- Implement only SG-0201 through SG-0206; do not begin Chromium, routing, database, API, authentication, relay, or managed tasks.
- Use only current official Cloudflare documentation as the runtime source of truth.
- Never print, serialize, log, or commit Cloudflare credentials or secret-bearing upstream data.
- Every provider network operation must honor `AbortSignal` and a finite `timeoutMs` without internal retry loops.
- Use the exact existing `runProviderConformanceSuite()` contract unchanged.
- Run the gated live test only when both required Cloudflare variables are present and non-empty, and always terminate in `finally`.

---

### Task 1: Cloudflare Browser Run Configuration

**Files:**

- Modify: `.env.example`
- Modify: `packages/config/src/types.ts`
- Modify: `packages/config/src/validation.ts`
- Modify: `packages/config/test/config.test.ts`
- Modify: `packages/config/README.md`

**Interfaces:**

- Consumes: `parseConfig(environment: EnvironmentSource): SurfGateConfig`
- Produces: `CloudflareCredentials` with `accountID` and `browserRunAPIToken`, available only through `SurfGateConfig.cloudflare.credentials`.

- [x] **Step 1: Write failing configuration tests**

```ts
expect(
  parseConfig({
    ...validEnvironment,
    CLOUDFLARE_ACCOUNT_ID: 'a',
    CLOUDFLARE_BROWSER_RUN_API_TOKEN: 't',
  }).cloudflare.credentials,
).toEqual({ accountID: 'a', browserRunAPIToken: 't' })
expect(() =>
  parseConfig({ ...validEnvironment, CLOUDFLARE_BROWSER_RUN_API_TOKEN: 'secret' }),
).toThrowError(/CLOUDFLARE_ACCOUNT_ID/u)
```

- [x] **Step 2: Run the focused tests and confirm the old variable contract fails**

Run: `pnpm --filter @surfgate/config test`
Expected: FAIL because `CLOUDFLARE_BROWSER_RUN_API_TOKEN` is not parsed yet.

- [x] **Step 3: Implement the single config-boundary rename and validation**

```ts
export type CloudflareCredentials = Readonly<{
  accountID: string
  browserRunAPIToken: string
}>
```

Parse the exact pair `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_RUN_API_TOKEN`; keep both optional together and keep all issue messages value-free.

- [x] **Step 4: Run config tests**

Run: `pnpm --filter @surfgate/config test`
Expected: PASS.

### Task 2: Kitesurf Transport, Descriptor, Health, Allocation, and Termination

**Files:**

- Create: `packages/provider-kitesurf/src/cloudflare-transport.ts`
- Create: `packages/provider-kitesurf/src/kitesurf-browser-provider.ts`
- Modify: `packages/provider-kitesurf/src/index.ts`
- Modify: `packages/provider-kitesurf/package.json`
- Replace: `packages/provider-kitesurf/tsconfig.json`
- Create: `packages/provider-kitesurf/tsconfig.build.json`
- Create: `packages/provider-kitesurf/test/kitesurf-browser-provider.test.ts`

**Interfaces:**

- Consumes: `CloudflareConfig`, `BrowserProvider`, provider-core schemas/errors, and `CapabilitySupportMapSchema`.
- Produces: `KitesurfBrowserProvider implements BrowserProvider`, `createKitesurfBrowserProvider(config, options?)`, and stable `KITESURF_CAPABILITIES`.

- [x] **Step 1: Write failing provider tests first**

```ts
const provider = createKitesurfBrowserProvider(config, { fetch: scriptedFetch, now: fixedNow })
await expect(provider.allocate(request, { timeoutMs: 100 })).resolves.toMatchObject({
  reference: { providerID: 'cloudflare-browser-run', runtimeClass: 'kitesurf' },
})
expect(scriptedRequest.url.searchParams.get('browser')).toBe('kitesurf')
expect(scriptedRequest.authorizationHeaderPresent).toBe(true)
```

Cover all required status mappings, malformed bodies, cancellation phases, timeout, idempotent delete, fixed-host URL validation, and secret sanitization without asserting a raw token value.

- [x] **Step 2: Run focused tests and confirm the provider is absent**

Run: `pnpm --filter @surfgate/provider-kitesurf test`
Expected: FAIL because the provider exports do not exist.

- [x] **Step 3: Implement bounded standard-fetch transport**

```ts
type CloudflareTransport = Readonly<{
  request(
    operation: ProviderOperation,
    path: string,
    init: RequestInit,
    options: ProviderOperationOptions,
  ): Promise<Response>
}>
```

Build URLs only beneath the configured HTTPS base URL and configured account path; attach `Authorization: Bearer …` internally; compose caller cancellation with a timeout controller; never retain response bodies in errors; map 401/403, 429, 5xx, abort, timeout, connection, and unknown failures to canonical `ProviderError` values.

- [x] **Step 4: Implement the descriptor and conservative capability map**

```ts
export const KITESURF_CAPABILITIES = CapabilitySupportMapSchema.parse({
  javascript: 'experimental',
  dom: 'experimental',
  xhr: 'experimental',
  svg: 'experimental',
  screenshot: 'experimental',
  pdf: 'experimental',
  webgl: 'unsupported',
  video: 'unsupported',
  persistentAuth: 'unsupported',
  realBrowserTLS: 'unsupported',
  downloads: 'unknown',
  uploads: 'unknown',
  multiTab: 'unsupported',
  longSession: 'unsupported',
})
```

Use `experimental` for beta features with explicit current documentation and `unknown` when the docs make no reliable claim.

- [x] **Step 5: Implement cheap health probing**

Call `GET /accounts/{account}/browser-run/devtools/session?limit=1`; return not configured locally, healthy on a valid list, degraded for rate/capacity response, unavailable for auth/5xx/connection, and throw only normalized cancellation/timeout/unknown errors.

- [x] **Step 6: Implement allocation and cleanup**

Call `POST /accounts/{account}/browser-run/devtools/browser?browser=kitesurf`, runtime-validate `{ sessionId, webSocketDebuggerUrl }`, require a clean Cloudflare-owned WSS session URL with no userinfo/query/fragment, and return `ProviderSessionSchema.parse(...)` with an opaque credential reference. Call `DELETE /accounts/{account}/browser-run/devtools/browser/{sessionId}`; accept `closing` or `closed`; treat local repeats and 404 as `already_terminated`; keep all other failures normalized and bounded.

- [x] **Step 7: Run focused provider tests**

Run: `pnpm --filter @surfgate/provider-kitesurf test`
Expected: PASS.

### Task 3: Shared and Live Conformance

**Files:**

- Create: `packages/provider-kitesurf/test/kitesurf-browser-provider.conformance.test.ts`
- Create: `packages/provider-kitesurf/test/kitesurf-browser-provider.live.test.ts`
- Create: `packages/provider-kitesurf/test/test-transport.ts`
- Modify: `packages/provider-kitesurf/package.json`

**Interfaces:**

- Consumes: exact `runProviderConformanceSuite()` and `ProviderConformanceScenario` from `@surfgate/testing`.
- Produces: deterministic scenario-backed Kitesurf conformance and `test:live` script gated by config credentials.

- [x] **Step 1: Add a complete scripted fetch fixture**

The fixture records only method, sanitized URL structure, and header names, and returns complete Cloudflare response objects. It exposes scenario data for health/allocation/termination delays, status codes, malformed JSON, network throws, and secret-bearing bodies without monkey-patching provider methods.

- [x] **Step 2: Run the exact shared suite against Kitesurf**

```ts
runProviderConformanceSuite({
  name: 'KitesurfBrowserProvider',
  createProvider: createKitesurfConformanceProvider,
  allocateRequest: createKitesurfAllocateRequest,
})
```

Run: `pnpm --filter @surfgate/provider-kitesurf test:conformance`
Expected: PASS.

- [x] **Step 3: Add the gated live lifecycle test**

Load configuration through `@surfgate/config`; skip when credentials are absent; otherwise allocate one Kitesurf session and validate it, then terminate it in `finally`. Do not navigate unless necessary and do not output headers, tokens, or upstream response bodies.

- [x] **Step 4: Run the gated live test**

Run: `pnpm --filter @surfgate/provider-kitesurf test:live`
Expected with configured credentials: one live lifecycle test PASS and cleanup succeeds.

### Task 4: Documentation and Repository Verification

**Files:**

- Modify: `packages/provider-kitesurf/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/PRD.md`
- Modify: `docs/ROUTING.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: implemented runtime semantics and official Cloudflare sources dated through 2026-08-07.
- Produces: synchronized provider lifecycle, capability, testing, and operational documentation.

- [x] **Step 1: Document the verified current contract**

Record the `/browser-run/devtools/browser?browser=kitesurf` allocation path, clean returned session WSS URL, DELETE idempotency semantics, Browser Rendering Write permission, inactivity limits, beta capability posture, and the older `/browser-rendering` documentation discrepancy.

- [x] **Step 2: Format and run focused quality checks**

Run: `pnpm format`
Run: `pnpm --filter @surfgate/config lint && pnpm --filter @surfgate/config typecheck && pnpm --filter @surfgate/config test`
Run: `pnpm --filter @surfgate/provider-kitesurf lint && pnpm --filter @surfgate/provider-kitesurf typecheck && pnpm --filter @surfgate/provider-kitesurf test && pnpm --filter @surfgate/provider-kitesurf build`
Expected: all PASS.

- [x] **Step 3: Run repository gates**

Run: `pnpm format:check`
Run: `pnpm lint`
Run: `pnpm typecheck`
Run: `pnpm test`
Run: `pnpm build`
Run: `pnpm check`
Expected: all PASS.

- [x] **Step 4: Review complete diff and security boundaries**

Search for direct `process.env` outside config, `any`, credential literals, raw authorization values, Cloudflare leakage into provider-core/contracts, unbounded fetches, query-bearing returned endpoints, non-idempotent cleanup, unsafe retries, and unrelated changes. Resolve every P0/P1 issue before completion.
