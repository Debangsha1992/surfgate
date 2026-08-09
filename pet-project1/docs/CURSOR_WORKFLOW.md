# Cursor Development Workflow

These prompts are intended to be pasted into Cursor Agent one at a time.

The repository's `AGENTS.md` and `.cursor/rules` are authoritative.

---

## Prompt 1 — Bootstrap

```text
Read AGENTS.md, docs/PRD.md, docs/ARCHITECTURE.md, and docs/IMPLEMENTATION_PLAN.md.

Implement only SG-0001: the monorepo baseline.

Requirements:
- Node 24 LTS.
- pnpm workspace.
- TypeScript strict configuration using the flags required by AGENTS.md.
- Create the apps/packages directories described in ARCHITECTURE.md.
- Add lint, formatting, typecheck, test, build, and check commands.
- Do not implement product logic yet.
- Do not add dependencies that are not needed for this bootstrap.
- Add a trivial compile/test fixture proving the workspace works.
- Run the relevant checks and fix failures.
- At the end, summarize files changed and commands run.
```

---

## Prompt 2 — Contracts

```text
Read AGENTS.md and docs/API.md.

Implement SG-0101 and SG-0102 only:
- common public error type/code structure,
- capability names,
- support states,
- capability requirement model,
- runtime validation schemas,
- unit tests.

Keep packages/contracts framework-independent.
Do not add provider SDKs.
Do not implement routing scoring yet.

Run focused tests, typecheck, lint, then repository check if practical.
```

---

## Prompt 3 — Provider core

```text
Read AGENTS.md, docs/ARCHITECTURE.md, docs/TESTING.md, and current contracts.

Implement SG-0103 through SG-0105:
- provider-core interface,
- normalized provider errors,
- fake provider,
- reusable provider conformance suite.

Do not implement Cloudflare yet.
Design interfaces so provider credentials remain internal.

Prove the fake provider passes conformance.
```

---

## Prompt 4 — Kitesurf adapter

```text
Read AGENTS.md and the current Cloudflare Kitesurf/Browser Run documentation linked in docs/PRD.md.

Before coding, verify the current Browser Run CDP endpoint and how Kitesurf is selected. Do not assume the August 2026 beta syntax is unchanged.

Implement the Cloudflare Kitesurf provider behind provider-core.
No Cloudflare types may leak into public contracts.

Add mocked tests and a separately gated live conformance test.
Never print the Cloudflare API token.
```

---

## Prompt 5 — Chromium adapter

```text
Implement a Chromium provider using the same provider-core contract and conformance suite.

Prefer Cloudflare Browser Run Chromium for production semantics.
If adding local Chromium for development, keep it a separate provider configuration.

Do not duplicate Kitesurf adapter code if shared HTTP/CDP setup belongs in a private shared Cloudflare helper.
Do not make providers depend on each other.
```

---

## Prompt 6 — Router

```text
Read docs/ROUTING.md completely.

Implement deterministic routing as pure logic where possible:
1. validation,
2. hard capability filtering,
3. policy/health filtering,
4. scoring,
5. stable tie-break,
6. reason codes.

Do not call provider SDKs from the router.
Do not add ML/LLM routing.

Add golden tests for every scenario listed in docs/ROUTING.md.
```

---

## Prompt 7 — Session API

```text
Read docs/API.md, docs/SECURITY.md, and docs/ARCHITECTURE.md.

Implement the session control plane incrementally:
- tenant/API key auth,
- session persistence,
- POST/GET/DELETE session,
- idempotency,
- routing and provider allocation orchestration,
- one bounded fallback.

Do not implement WebSocket relay in the same change unless the control plane is already fully tested.
```

---

## Prompt 8 — Relay

```text
Read the relay sections of AGENTS.md, ARCHITECTURE.md, SECURITY.md, THREAT_MODEL.md, and TESTING.md.

Implement:
- short-lived signed relay credential,
- WSS upgrade auth,
- upstream secret resolution,
- bounded bidirectional relay,
- backpressure,
- frame and duration limits,
- termination/revocation,
- integration tests using a fake upstream WebSocket.

Never log raw CDP payloads.
```

---

## Prompt 9 — Security hardening

```text
Implement the mandatory SSRF, redirect, DNS/IP, cross-tenant, token replay, and redaction tests in docs/SECURITY.md and docs/THREAT_MODEL.md.

Treat any newly found security failure as a product bug.
Do not weaken tests to make them pass.
```

---

## Prompt 10 — Production review

```text
Act as a production-readiness reviewer.

Read the entire repository and compare implementation against:
- AGENTS.md
- docs/PRD.md acceptance criteria
- docs/SECURITY.md
- docs/TESTING.md
- docs/OBSERVABILITY.md

Do not change code first.

Produce a prioritized gap list:
P0 security/data integrity
P1 reliability/correctness
P2 operability/performance
P3 developer experience

For each gap cite the exact file/code path and requirement it violates.
Then wait for me to choose what to implement.
```
