# Getting Started

This guide runs SurfGate from a fresh development machine. SurfGate is an experimental developer preview.

## Prerequisites

- Node.js `>=24 <25`
- Corepack and pnpm `10.15.1`
- Docker with Docker Compose
- OpenSSL for local key generation
- A private S3-compatible bucket to run the managed-task worker
- A Cloudflare account ID and Browser Run API token to allocate live Kitesurf or Chromium sessions

PostgreSQL and Redis are provided by `docker-compose.dev.yml`. Deterministic tests do not need Cloudflare credentials or object storage.

## Choose a development path

- **Deterministic development and tests:** install dependencies and run `pnpm check`. No Cloudflare or object-storage credentials are required.
- **Local SurfGate services:** configure the two local security keys, start PostgreSQL/Redis, migrate the database, and run the API/relay. Without Cloudflare credentials, the services can validate configuration and health but cannot allocate a real browser.
- **Live browser sessions:** additionally configure the Cloudflare account ID and Browser Run token. Run the worker only after configuring a private S3-compatible bucket.

## Install

```bash
git clone https://github.com/Debangsha1992/surfgate.git
cd surfgate
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Generate two different 32-byte base64 keys:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

Put the first value in `SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY` and the second in `SURFGATE_RELAY_TOKEN_SIGNING_KEY`. Never commit `.env`, and never reuse one key for both purposes.

For live allocation, also set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_RUN_API_TOKEN`. These are not required for `pnpm check` or ordinary deterministic tests.

To run the worker, configure `S3_REGION`, `S3_BUCKET`, and—when needed by the service—`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. The bucket must be private. The development Compose file intentionally does not bundle an object-storage service.

## Start infrastructure and migrate

```bash
docker compose -f docker-compose.dev.yml up -d --wait
docker compose -f docker-compose.dev.yml ps
pnpm --filter @surfgate/api db:migrate
```

On first start, Compose creates the local `surfgate` PostgreSQL database declared in `docker-compose.dev.yml`; the migration command creates the SurfGate schema.

Create a development tenant and API key:

```bash
pnpm --filter @surfgate/api bootstrap:dev
```

The command is disabled in production. It prints the `sg_test_...` secret once; copy it into your shell, not `.env`:

```bash
export SURFGATE_API_KEY='sg_test_replace_with_bootstrap_output'
```

## Start services

Use separate terminals so failures remain visible:

```bash
pnpm --filter @surfgate/api dev
pnpm --filter @surfgate/relay dev
pnpm --filter @surfgate/worker dev
```

The worker requires PostgreSQL and object storage. Alternatively, `pnpm dev` starts all persistent workspace development commands.

Verify liveness and readiness:

```bash
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8081/health/ready
curl --fail http://127.0.0.1:8082/health/ready
```

Liveness means the process is running. Readiness means its required dependencies can safely accept new work.

## Create your first session

```bash
curl --fail-with-body http://127.0.0.1:8080/v1/sessions \
  -H "Authorization: Bearer $SURFGATE_API_KEY" \
  -H "Idempotency-Key: getting-started-session" \
  -H 'Content-Type: application/json' \
  --data '{"capabilities":{"javascript":"required","dom":"required"},"runtime":{"preference":"auto","allowFallback":true,"allowExperimental":false},"maxDurationSeconds":600}'
```

Save the returned `session.id`. `targetUrl`, when supplied, is policy-validated routing/allocation context; it does not itself perform browser navigation. Navigate through the CDP connection before running a page task.

## Request a relay token

```bash
export SURFGATE_SESSION_ID='ses_replace_with_session_id'
curl --fail-with-body -X POST \
  "http://127.0.0.1:8080/v1/sessions/$SURFGATE_SESSION_ID/relay-token" \
  -H "Authorization: Bearer $SURFGATE_API_KEY"
```

Use the returned short-lived token in the WebSocket `Authorization` header. See [`examples/playwright-cdp`](../examples/playwright-cdp/) for a client connection.

## Run a managed task

After navigating the active session through CDP:

```bash
curl --fail-with-body \
  "http://127.0.0.1:8080/v1/sessions/$SURFGATE_SESSION_ID/tasks" \
  -H "Authorization: Bearer $SURFGATE_API_KEY" \
  -H "Idempotency-Key: getting-started-extract" \
  -H 'Content-Type: application/json' \
  --data '{"type":"extract"}'
```

Poll the returned task ID:

```bash
curl --fail-with-body \
  "http://127.0.0.1:8080/v1/tasks/tsk_replace_with_task_id" \
  -H "Authorization: Bearer $SURFGATE_API_KEY"
```

Screenshot and PDF results contain artifact metadata; download bytes from `/v1/artifacts/:artifactId`. Managed tasks use at-least-once delivery and do not promise exactly-once browser execution.

## Stop local infrastructure

Stop the application processes, then run:

```bash
docker compose -f docker-compose.dev.yml down
```

Add `-v` only when you intentionally want to delete the local PostgreSQL and Redis volumes.

## Troubleshooting

- **Unsupported Node version:** use Node 24; the repository intentionally rejects other majors.
- **API not ready:** check PostgreSQL, Redis, migrations, and `.env` validation.
- **Relay not ready:** check PostgreSQL, Redis, and that the API/relay share the signing-key configuration.
- **Worker not ready:** configure reachable private S3-compatible storage in addition to PostgreSQL.
- **No provider configured:** set both Cloudflare variables for live allocation.
- **Task unsupported:** the existing session runtime must declare the required task capability. SurfGate never swaps an active session to another runtime.
- **Integration tests:** use an isolated database whose name ends with `_test`; never point tests at production.

See the [User Guide](USER_GUIDE.md), [Security Model](SECURITY_MODEL.md), and [operations runbooks](../operations/runbooks.md) for more detail.

## Run tests

The complete deterministic gate is:

```bash
pnpm check
```

Focused security, conformance, and integration commands are defined in the root `package.json`. `pnpm test:integration` requires Redis and isolated PostgreSQL test configuration; `TEST_DATABASE_URL` must name a database ending in `_test`. Live provider tests are separately gated and must never receive credentials in pull-request CI.
