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
    Relay[Authenticated CDP Relay]

    Client --> API
    API --> Router
    Router --> K
    Router --> C
    API --> DB
    API --> Redis
    Client --> Relay
    Relay --> K
    Relay --> C
    Relay --> DB
    Relay --> Redis
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
- Short-lived tenant/session-scoped relay credentials
- Independently deployable authenticated CDP WebSocket relay
- One-controller-per-session Redis coordination and distributed revocation
- Bounded bidirectional streaming with frame, queue, idle, session, and absolute limits

Managed task execution is not implemented yet. Clients connect to the SurfGate relay and never receive upstream provider WebSocket endpoints or Cloudflare credentials.

## Repository Structure

```text
apps/
  api/                    Fastify control plane and persistence
  relay/                  Authenticated bounded CDP data plane
  worker/                 Managed-task package boundary; implementation pending

packages/
  contracts/              Public schemas, IDs, capabilities, and errors
  config/                 Validated runtime configuration
  router/                 Pure deterministic routing and fallback logic
  provider-core/          Provider-neutral lifecycle contract
  provider-cloudflare/    Private shared Cloudflare transport
  provider-kitesurf/      Kitesurf adapter
  provider-chromium/      Chromium adapter
  security/               Target policy, relay tokens, and protected references
  observability/          Structured control-plane and relay telemetry interfaces
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

Before starting the API or relay, set both `SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY` and `SURFGATE_RELAY_TOKEN_SIGNING_KEY` in the local `.env` to independently generated base64-encoded 32-byte values. Then run:

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
pnpm test:security
pnpm --filter @surfgate/router test:golden
pnpm test:relay-load
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
- `POST /v1/sessions/:sessionId/relay-token`

Session endpoints require tenant-scoped bearer authentication. Session creation also requires an `Idempotency-Key` header. The service publishes its runtime-schema-derived OpenAPI contract at `/openapi.json`.

Only an active, unexpired session can obtain a relay credential. The credential is short-lived, bound to one tenant and one session, and is accepted by the relay at `WS /v1/sessions/:sessionId/cdp` only through an `Authorization: Bearer` upgrade header. It is never placed in a URL or WebSocket subprotocol. One controller connection is permitted per session. Disconnecting the client closes only the relay transport; deleting or expiring the session revokes relay access and retains provider termination in the control plane.

The relay exposes separate `/health/live` and `/health/ready` endpoints. During shutdown it stops upgrades, closes active client/upstream pairs within the configured drain bound, releases Redis ownership, and exits. New connections fail closed when PostgreSQL or Redis authorization state is unavailable.

### Relay operations

- Drain a relay instance through its normal `SIGTERM`/`SIGINT` shutdown path; the configured drain timeout bounds graceful client/upstream closure before hard cleanup.
- Treat PostgreSQL and Redis readiness failures as authorization-safety failures. Restore the dependency before accepting new relay connections rather than bypassing the check.
- Investigate `UPSTREAM_CONNECT_FAILED` using provider health and server-side Cloudflare configuration. SurfGate deliberately omits upstream response bodies, authorization headers, and provider URLs from client errors and logs.
- Rotate `SURFGATE_RELAY_TOKEN_SIGNING_KEY` together with `SURFGATE_RELAY_TOKEN_SIGNING_KEY_ID` as a coordinated deployment. Existing short-lived credentials become invalid when the old key is removed, so schedule rotation around the configured token TTL (maximum five minutes).
- Keep provider-session encryption-key rotation separate from relay-token signing-key rotation; neither key may be reused for the other purpose.

The integration suite includes a browser-download-free Playwright Core `connectOverCDP` compatibility test. It verifies that a standard CDP client can authenticate to SurfGate through an upgrade header without learning the provider authorization credential.

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
- Relay tokens are signed, short-lived, audience-bound, and checked against current durable session state.
- Upstream WebSocket URLs and authorization headers remain inside the relay data plane.
- Frame and queue limits prevent slow peers from creating unbounded relay buffers.
- Authentication, policy, quota, and public error behavior use validated stable contracts.
- Target URLs accept only HTTP(S), reject embedded credentials, and deny localhost plus private, link-local, metadata, multicast, reserved, and other special-use IPv4/IPv6 destinations.
- Hostname targets are normalized, all bounded DNS answers are checked, resolution must remain stable across repeated checks, and the target is checked again immediately before provider allocation.
- Redirect-chain validation applies the same bounded URL, DNS, and destination policy to every supplied hop and rejects loops or excessive chains.
- API responses opt out of caching and MIME sniffing; request bodies and request lifetimes are bounded. Cross-origin access is disabled unless a future explicit policy enables it.
- Structured API and relay logging share recursive, non-mutating redaction for authorization data, API/relay/provider tokens, cookies, passwords, connection credentials, and secret-bearing URLs.
- SurfGate does not provide CAPTCHA bypass, stealth plugins, TLS fingerprint spoofing, or other anti-bot evasion features.

Raw CDP frames, page content, cookies, relay tokens, and provider URLs are never included in normal logs. SurfGate does not migrate or replay an active CDP session across runtimes.

### Browser-navigation security boundary

The control plane validates a requested `targetUrl`, but the current Cloudflare allocation API creates a browser session without asking SurfGate to perform that navigation. Once an authenticated client controls the transparent CDP relay, commands such as `Page.navigate`, script-driven navigation, popups, and browser subresource requests are resolved inside the provider browser. SurfGate currently cannot pin that browser's DNS socket or inspect every provider-side redirect, so the URL policy and redirect-chain helper must not be interpreted as complete SSRF isolation for arbitrary raw CDP activity.

Only trusted tenant principals should receive API keys and relay credentials. Deployments requiring untrusted raw-CDP users need an egress policy or provider/browser request-interception layer that independently enforces allowed destinations. That enforcement is deliberately not claimed by the current milestone.
