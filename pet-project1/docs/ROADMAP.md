# SurfGate Roadmap

This is ordered by dependency, not calendar duration.

## Stage 0 — Foundation

- pnpm monorepo
- TypeScript strict baseline
- CI
- local Postgres/Redis
- config package
- contract package
- OTel bootstrap
- migration framework

Exit:
- `pnpm check` green
- local services documented

## Stage 1 — Provider abstraction

- capability model
- provider interface
- normalized error taxonomy
- fake provider
- conformance harness

Exit:
- fake provider passes shared suite

## Stage 2 — Initial runtimes

- Cloudflare Kitesurf adapter
- Cloudflare Chromium adapter
- provider health
- live trusted conformance

Exit:
- navigate and required basic probes work through both providers as supported

## Stage 3 — Router

- hard constraints
- deterministic scoring
- reason codes
- fallback classifier
- persisted decisions

Exit:
- golden routing suite

## Stage 4 — Control plane

- tenants
- API keys
- sessions
- idempotency
- quotas
- audit
- OpenAPI

Exit:
- session can be allocated/terminated via REST

## Stage 5 — Relay

- signed credential
- WSS relay
- backpressure
- timeouts
- revocation
- cleanup

Exit:
- Playwright/Puppeteer-compatible connection through SurfGate without provider secret exposure

## Stage 6 — Managed tasks

- extract
- screenshot
- PDF
- artifacts
- task state

Exit:
- one-shot task API works with routing/fallback

## Stage 7 — Hardening

- SSRF suite
- DNS/redirect protections
- load tests
- chaos tests
- reconciliation
- dashboards
- alerts

Exit:
- production-readiness checklist passed

## Stage 8 — Developer release

- TypeScript SDK
- CLI
- examples
- docs site
- OSS license
- contributor docs

## Stage 9 — Intelligence

- domain/runtime compatibility history
- cost-aware tuning
- policy DSL
- Python SDK
- MCP server
- additional providers
