# SurfGate

**Browser Runtime Router for AI Agents**

SurfGate gives AI agents and automation systems one provider-neutral browser interface and routes each workload to the best available browser runtime.

The initial runtime strategy is:

- **Cloudflare Kitesurf** as the preferred fast path for compatible, short-lived, stateless workloads.
- **Chromium** as the compatibility fallback for workloads that require features Kitesurf does not currently support well.
- A provider interface that allows additional browser backends later without changing client applications.

SurfGate is infrastructure. It is not an autonomous browsing agent, scraping marketplace, anti-bot bypass product, or CAPTCHA circumvention system.

## Core idea

```text
                         AI AGENTS / AUTOMATION
                                  │
                  ┌───────────────┼───────────────┐
                  │               │               │
                 SDK             REST            CDP
                  │               │               │
                  └───────────────┼───────────────┘
                                  ▼
                         ┌─────────────────┐
                         │    SurfGate     │
                         │  Control Plane  │
                         └────────┬────────┘
                                  │
                       Policy + Capability Filter
                                  │
                                  ▼
                         Runtime Router
                         /             \
                        /               \
                 Kitesurf             Chromium
                 fast path            fallback
```

## Why SurfGate

Agent teams should not need to hard-code browser infrastructure into their products.

A task may be cheap and efficient on a lightweight engine but fail because it needs WebGL, long-lived authenticated state, a browser-specific API, or rendering fidelity. SurfGate centralizes that decision and adds:

- Runtime capability detection
- Deterministic routing
- Automatic fallback
- Session brokering
- CDP relay
- Retries and timeouts
- Quotas and rate limits
- Security policy enforcement
- Audit trails
- OpenTelemetry traces and metrics
- Cost and success-rate accounting
- Provider health monitoring
- Domain/runtime compatibility history

## Repository status

This repository is currently at **product specification / implementation scaffold** stage.

Start with:

1. `docs/PRD.md`
2. `docs/ARCHITECTURE.md`
3. `docs/IMPLEMENTATION_PLAN.md`
4. `AGENTS.md`
5. `.cursor/rules/`

## Proposed stack

- Node.js 24 LTS
- TypeScript, strict mode
- pnpm workspaces
- Fastify for HTTP/WebSocket control plane
- PostgreSQL for durable metadata and audit records
- Redis for ephemeral session registry, locks, quotas, and rate limiting
- S3-compatible object storage (Cloudflare R2 or S3) for screenshots, traces, and artifacts
- OpenTelemetry for traces, metrics, and structured log correlation
- Vitest for unit/integration tests
- Playwright/Puppeteer-compatible CDP clients for runtime contract testing

The architecture intentionally hides vendor-specific details behind provider adapters.

## Planned monorepo

```text
surfgate/
├── apps/
│   ├── api/                    # REST API + auth + session broker
│   ├── relay/                  # WebSocket/CDP data-plane relay
│   └── worker/                 # async task execution
├── packages/
│   ├── contracts/              # public schemas and types
│   ├── config/                 # validated configuration
│   ├── router/                 # routing policy + scoring
│   ├── provider-core/          # provider interfaces
│   ├── provider-kitesurf/      # Cloudflare Kitesurf adapter
│   ├── provider-chromium/      # Chromium adapter
│   ├── security/               # URL/egress/policy controls
│   ├── observability/          # OTel helpers
│   └── testing/                # provider conformance tests
├── docs/
├── .cursor/rules/
└── AGENTS.md
```

## Development principles

1. Provider-neutral public APIs.
2. Kitesurf is a runtime, not the architecture.
3. Deterministic routing before ML-based routing.
4. Fail closed on security boundaries.
5. No provider credentials reach clients.
6. No secrets or unredacted browser payloads in logs.
7. Every fallback must be observable and explainable.
8. Every provider must pass the same conformance suite.
9. Browser execution is untrusted input processing.
10. Changes are incomplete until tests, telemetry, and docs are updated.

## Key documents

- [Product Requirements](docs/PRD.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API Contract](docs/API.md)
- [Routing Specification](docs/ROUTING.md)
- [Security](docs/SECURITY.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Observability](docs/OBSERVABILITY.md)
- [Testing](docs/TESTING.md)
- [Operations](docs/OPERATIONS.md)
- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md)
- [Roadmap](docs/ROADMAP.md)
- [Cursor Workflow](docs/CURSOR_WORKFLOW.md)

## Current Kitesurf assumptions

These assumptions are based on Cloudflare's August 6, 2026 Kitesurf announcement and should be revalidated before major releases:

- Kitesurf is available through Cloudflare Browser Run while in beta.
- It uses CDP-compatible interfaces and can work with clients such as Playwright and Puppeteer.
- Cloudflare describes it as an ephemeral, isolated, stateless engine for bursty AI workloads.
- Kitesurf currently implements a subset of CDP.
- Cloudflare recommends Chromium instead for workloads requiring video, WebGL, real-TLS bot challenge behavior, or long persistent authenticated sessions.
- Cloudflare states it is still improving CDP coverage, rendering fidelity, WPT coverage, and production readiness.

Source: https://blog.cloudflare.com/kitesurf/

## License

Choose a license before the first public release. Apache-2.0 is recommended for an infrastructure project unless there is a reason to use another license.
