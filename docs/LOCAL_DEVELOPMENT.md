# Local Development

## Prerequisites

- Node.js 24 LTS
- pnpm via Corepack
- Docker / Docker Compose

## Services

Local infrastructure:

```text
PostgreSQL 17 : 127.0.0.1:5432
Redis 8       : 127.0.0.1:6379
```

The Compose project uses pinned image versions, deterministic development credentials, UTC,
durable named volumes, and health checks. It intentionally contains no application or telemetry
services.

Do not run production provider live tests by default.

## Environment

Copy:

```bash
cp .env.example .env
```

Never commit `.env`.

In local development, `@surfgate/config` loads the repository `.env` and then applies process
environment overrides. In production, `.env` is ignored and the process environment is the only
configuration source. Only the process environment can select production mode.

## Infrastructure lifecycle

Start PostgreSQL and Redis:

```bash
docker compose -f docker-compose.dev.yml up -d
```

Check service and health status:

```bash
docker compose -f docker-compose.dev.yml ps
```

Stop both services while retaining their named volumes:

```bash
docker compose -f docker-compose.dev.yml down
```

Application startup never runs these commands automatically. Start infrastructure explicitly
before `pnpm dev` when a development task needs it.

Create the isolated database once for API integration tests:

```bash
docker compose -f docker-compose.dev.yml exec -T postgres \
  createdb -U surfgate surfgate_test
```

Run migrations against the normal local database explicitly:

```bash
pnpm --filter @surfgate/api db:migrate
```

Run database integration tests only against the `_test` database:

```bash
TEST_DATABASE_URL=postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate_test \
  pnpm --filter @surfgate/api test:integration
```

Generate the local provider-session encryption value with a cryptographically secure
32-byte random source, base64 encode it, and place it only in `.env`. Production requires
this value and must obtain it from managed secret storage. Never commit it.

Session creation also requires Redis. Quota, provider-operation, and idempotency wait
defaults are documented in `.env.example`; invalid values fail startup configuration parsing.
The integration command above exercises PostgreSQL migrations/repositories, Redis rate limits,
authenticated API create/read/delete, cross-tenant denial, and fake-provider cleanup.

## Commands

```bash
corepack enable
pnpm install
pnpm dev
```

Quality:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

## Cloudflare credentials

Only needed for live Kitesurf/Browser Run tests.

Use a dedicated development token with minimum Browser Run/Rendering permissions.

Never place the token in:

- committed files,
- test fixtures,
- command-line examples pasted into CI logs,
- URLs.

Live tests must skip with a clear reason when credentials are absent.
