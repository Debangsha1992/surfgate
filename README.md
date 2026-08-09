# SurfGate

SurfGate is a provider-neutral browser runtime router and control plane for AI agents. It accepts capability-driven session requests, applies tenant policy and deterministic routing, and allocates either a lightweight Kitesurf runtime or a full Chromium runtime without exposing provider credentials to clients.

## Why SurfGate

Browser workloads do not all need the same runtime. A short-lived DOM or screenshot task may fit an efficient lightweight engine, while WebGL, persistent authentication, multi-tab work, or broader browser compatibility may require Chromium.

SurfGate provides one stable abstraction over those runtimes. Kitesurf is the preferred fast path when its declared capabilities satisfy the request; Chromium is the compatibility path. Public contracts remain provider-neutral, and required capabilities or tenant policy always take precedence over preference and score.

## Architecture

```mermaid
flowchart TD
    Client[AI Agent / Client]
    API[SurfGate Control Plane]
    Router[Deterministic Router]
    K[Kitesurf Provider]
    C[Chromium Provider]
    DB[(PostgreSQL)]
    Redis[(Redis)]

    Client --> API
    API --> Router
    Router --> K
    Router --> C
    API --> DB
    API --> Redis
```

The control plane authenticates clients, validates requests, applies quotas and idempotency, records routing decisions, allocates through the provider interface, persists session state, and emits audit and telemetry events. The router remains pure domain logic and never performs network or database operations.

## Current Status

The current implementation includes:

- Node.js 24, pnpm, Turbo, strict TypeScript, ESLint, Prettier, and Vitest monorepo tooling
- Runtime-validated typed configuration
- Provider-neutral IDs, errors, capabilities, session contracts, and runtime schemas
- A shared browser-provider interface, deterministic fake provider, and reusable conformance suite
- Cloudflare Browser Run adapters for Kitesurf and Chromium
- Deterministic hard filtering, scoring, stable reason codes, decision records, and bounded fallback
- PostgreSQL migrations and tenant-scoped repositories
- Tenant and API-key authentication with one-time key issuance and non-plaintext storage
- Race-safe session state transitions and encrypted provider-session references
- Authenticated session creation, inspection, and idempotent termination
- Durable idempotency, concurrent-session quotas, Redis request-rate limiting, audit events, and telemetry hooks
- Runtime-schema-coupled OpenAPI output

The WebSocket/CDP relay and managed task execution are not implemented yet. The API does not expose upstream provider WebSocket endpoints or placeholder relay credentials.

## Repository Structure

```text
apps/
  api/                    Fastify control plane and persistence
  relay/                  Relay package boundary; implementation pending
  worker/                 Managed-task package boundary; implementation pending

packages/
  contracts/              Public schemas, IDs, capabilities, and errors
  config/                 Validated runtime configuration
  router/                 Pure deterministic routing and fallback logic
  provider-core/          Provider-neutral lifecycle contract
  provider-cloudflare/    Private shared Cloudflare transport
  provider-kitesurf/      Kitesurf adapter
  provider-chromium/      Chromium adapter
  security/               Target URL and network policy primitives
  observability/          Structured control-plane telemetry interfaces
  testing/                Fake provider and shared conformance suite
```

## Prerequisites

- Node.js 24 LTS
- pnpm 10.15.1 through Corepack
- Docker with Docker Compose

Local PostgreSQL 17 and Redis 8 are provided by `docker-compose.dev.yml`.

## Local Development

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
```

Before starting the API, set `SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY` in the local `.env` to a securely generated base64-encoded 32-byte value. Then run:

```bash
pnpm --filter @surfgate/api db:migrate
pnpm dev
```

Keep `.env` local. Cloudflare account credentials are optional for ordinary builds and deterministic tests; they are required only for separately gated live Kitesurf, Chromium, or control-plane provider tests.

Check or stop local infrastructure with:

```bash
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml down
```

## Quality Gates

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Additional established suites include:

```bash
pnpm test:integration
pnpm test:conformance
pnpm --filter @surfgate/router test:golden
pnpm --filter @surfgate/security test
```

Integration tests require Redis and an isolated PostgreSQL database whose name ends in `_test`. Create the local test database once and run the suite with:

```bash
docker compose -f docker-compose.dev.yml exec -T postgres \
  createdb -U surfgate surfgate_test

TEST_DATABASE_URL=postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate_test \
  pnpm --filter @surfgate/api test:integration
```

Live provider tests are gated separately and are not part of normal CI or `pnpm check`.

## API

Implemented HTTP endpoints:

- `GET /health/live`
- `GET /health/ready`
- `GET /openapi.json`
- `POST /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `DELETE /v1/sessions/:sessionId`

Session endpoints require tenant-scoped bearer authentication. Session creation also requires an `Idempotency-Key` header. The service publishes its runtime-schema-derived OpenAPI contract at `/openapi.json`.

## Routing

Routing is deterministic and explainable:

1. Hard capability, configuration, health, duration, safety, and tenant-policy constraints reject ineligible candidates.
2. Only eligible candidates receive a versioned deterministic score.
3. Stable reason codes and tie-breaking make decisions replayable.
4. A classified allocation failure may trigger at most one cross-runtime fallback.

Required capabilities can never be overridden by scoring. The initial `router-v1` policy prefers Kitesurf when compatible and healthy, while Chromium remains the broader compatibility path.

## Security

The current control plane is designed so that:

- Provider credentials and secret-bearing connection metadata remain server-side.
- API keys are shown only at creation and stored as salted one-way hashes.
- Durable resource access and repositories are tenant-scoped.
- Sensitive provider-session references are encrypted before persistence.
- Authentication, policy, quota, and public error behavior use validated stable contracts.
- SurfGate does not provide CAPTCHA bypass, stealth plugins, TLS fingerprint spoofing, or other anti-bot evasion features.

The CDP relay is not yet available; clients never receive an insecure direct-provider connection as a temporary substitute.
