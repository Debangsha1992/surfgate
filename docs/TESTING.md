# SurfGate Testing Strategy

## 1. Test pyramid

```text
           live compatibility probes
          provider conformance tests
        integration / contract tests
             unit tests
```

Most correctness should be proven without live public websites.

---

## 2. Unit tests

Pure units:

- capability matching,
- candidate rejection,
- scoring,
- tie-break,
- reason codes,
- fallback classification,
- state transitions,
- auth scope,
- URL validation,
- redaction,
- token claims,
- config parsing.

Router should have high deterministic unit coverage.

The executable Epic 4 router suite covers candidate identity/order, strict
input/policy schemas, hard eligibility, exact `router-v1` scoring, stable reason
codes, decision serialization, 19 golden selection cases, replay/tie invariants,
fallback classification, and the bounded fallback reducer. It uses only fixed
descriptors and health snapshots; no provider is instantiated and no network or
credentials are required.

Run all router tests or only the golden file selection with:

```bash
pnpm --filter @surfgate/router test
pnpm --filter @surfgate/router test:golden
```

Router changes must also rerun fake, Kitesurf, and Chromium provider conformance
to detect dependency-boundary regressions.

---

## 3. Contract tests

Public schemas:

- request examples validate,
- response examples validate,
- generated OpenAPI matches schemas,
- SDK serialization compatible.

Add snapshot tests cautiously; prefer semantic assertions.

Epic 5 adds strict create/public-session/termination contracts, a schema-derived OpenAPI
assertion, deterministic fake-provider orchestration cases, Fastify auth/tenant-safe route
tests, target-policy security tests, and real PostgreSQL/Redis integration. The real API
integration creates, replays, reads, cross-tenant-denies, terminates, and repeats termination
without contacting Cloudflare.

---

## 4. Provider conformance

Every provider adapter runs:

```text
descriptor returns valid capabilities
health maps correctly
allocate returns normalized session
terminate is idempotent
timeout aborts
errors normalize
secrets absent from returned public metadata
upstream disconnect classified
```

The executable shared suite is `runProviderConformanceSuite()` from
`@surfgate/testing`. Each adapter supplies the same named-scenario factory and a
valid `ProviderAllocateRequest`; the suite itself remains unchanged across fake,
Kitesurf, Chromium, and later providers.

Required scenario categories cover:

- configured healthy, degraded, unavailable, and not-configured health;
- delayed, canceled, and timed-out health checks;
- successful, delayed, canceled, timed-out, configuration-failed,
  authorization-failed, rate-limited, transient, unsupported, connection, and
  unknown allocation;
- successful, delayed, canceled, timed-out, failed, and unknown termination;
- secret-bearing upstream health, allocation, and termination errors that must
  normalize without leaking values.

The deterministic `FakeBrowserProvider` runs this suite without network access.
Its targeted tests use fake timers and AbortSignals rather than wall-clock
sleeps. Repeated or nonexistent termination must return `already_terminated`.

Run the shared suite explicitly:

```bash
pnpm --filter @surfgate/testing test:conformance
```

Kitesurf runs that unchanged suite from `@surfgate/testing` against a scripted
standard-fetch boundary:

```bash
pnpm --filter @surfgate/provider-kitesurf test:conformance
```

The Kitesurf package also has deterministic targeted coverage for configuration,
capabilities, health, allocation response validation, authorization-header
containment, selection, cancellation, timeouts, HTTP classification, bounded
response bodies, connection failures, secret sanitization, and idempotent
termination. Race-focused cases prove concurrent termination single-flight,
bounded recent-termination tracking, and cleanup of partially valid allocation
responses. These tests make no external network requests.

Chromium runs the exact same unchanged shared suite against its own scripted
Cloudflare boundary:

```bash
pnpm --filter @surfgate/provider-chromium test:conformance
```

Its targeted tests cover the standard Chromium namespace and selector omission,
the complete capability declaration, keep-alive clamping versus absolute
session expiry, fixed-host WSS validation, authorization-header containment,
all required HTTP/network classifications, cancellation and response-body
timeouts, invalid-allocation cleanup, secret sanitization, and idempotent
termination. The shared private Cloudflare lifecycle is therefore exercised by
both concrete provider suites.

The separately gated live lifecycle test runs only from its dedicated command:

```bash
pnpm --filter @surfgate/provider-kitesurf test:live
pnpm --filter @surfgate/provider-chromium test:live
```

It loads `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_BROWSER_RUN_API_TOKEN` through `@surfgate/config`, skips when the
pair is absent, allocates the smallest session without navigating, validates the
internal session contract, and terminates in `finally`. Normal package and pull
request test commands exclude `*.live.test.ts`, so untrusted changes do not
receive provider credentials and credential absence cannot fail the merge gate.

Browser behavior probes where provider supports them:

- navigate,
- DOM,
- evaluate JS,
- screenshot,
- PDF,
- cookies/session behavior,
- multi-tab if claimed.

A provider MUST NOT declare a capability `supported` unless the required conformance probe passes or there is a documented reason.

---

## 5. Integration

Use ephemeral/local:

- Postgres,
- Redis,
- object storage emulator or test bucket,
- fake provider server,
- fake upstream WebSocket.

Tests:

- create session,
- idempotent create,
- terminate twice,
- concurrent terminate,
- relay token,
- expiry,
- fallback,
- audit,
- artifacts.

The SG-0501–SG-0503 PostgreSQL suite uses only a database whose name ends in `_test` and
fails before cleanup against any other name. Tests apply committed migrations, isolate
data by opaque tenant IDs, and delete only those test tenants. They cover plaintext-key
absence, repository-backed authentication, cross-tenant session/decision denial,
compare-and-set transition races, routing-decision round trips, and idempotent termination.

Run it explicitly after creating `surfgate_test`:

```bash
TEST_DATABASE_URL=postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate_test \
  pnpm --filter @surfgate/api test:integration
```

Normal unit tests exclude `*.integration.test.ts`; integration tests never silently target
`DATABASE_URL`.

---

## 6. Security

Must include:

- private IPv4,
- loopback,
- link local,
- IPv6 local,
- malicious redirect,
- DNS rebinding simulation,
- protocol injection,
- cross tenant IDs,
- expired API key,
- expired relay token,
- token for wrong session,
- oversized frame,
- queue/backpressure,
- secret-bearing upstream error.

---

## 7. Load

Relay load test:

- concurrent WebSockets,
- representative frame sizes,
- slow client,
- fast upstream,
- fast client,
- slow upstream,
- abrupt disconnect,
- sustained duration.

Measure:

- RSS/heap,
- CPU,
- event loop delay,
- socket count,
- p95/p99 relay connect,
- errors,
- cleanup.

---

## 8. Chaos/failure

Inject:

- Kitesurf 5xx,
- Chromium 5xx,
- provider timeout,
- Redis restart,
- API restart,
- relay restart,
- Postgres unavailable,
- partial object storage failure.

Verify:

- bounded fallback,
- no retry storm,
- stable terminal state,
- leaked upstream cleaned.

---

## 9. Live-site compatibility

Separate, non-blocking or controlled CI.

Use stable public fixtures and Cloudflare's own compatible examples only where appropriate.

Never make the core PR test suite depend on arbitrary public websites.

Record:

- runtime,
- test case,
- result,
- timestamp,
- provider version signal if available.

---

## 10. CI gates

Pull request:

- formatting,
- lint,
- typecheck,
- unit,
- integration with local dependencies,
- build,
- secret scan.

Trusted branch/nightly:

- live provider conformance,
- compatibility matrix,
- load smoke,
- dependency scan.

---

## 11. Coverage

Do not optimize for a single percentage.

Critical code paths must be comprehensively tested:

- auth,
- tenant scoping,
- routing,
- fallback,
- SSRF,
- relay authorization,
- session transitions.

Coverage thresholds may be added after baseline exists.
