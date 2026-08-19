# Deployment and migration

## Vendor-neutral topology

Expose only the API TLS endpoint and relay WSS endpoint through the edge/load balancer. PostgreSQL, Redis, worker health, reconciliation, migration jobs, and object-storage administrative endpoints are private. The API, relay, and worker scale and deploy independently.

Build from the repository root:

```bash
docker build -f apps/api/Dockerfile -t surfgate-api:<sha> .
docker build -f apps/relay/Dockerfile -t surfgate-relay:<sha> .
docker build -f apps/worker/Dockerfile -t surfgate-worker:<sha> .
```

The multi-stage images use the locked pnpm version, frozen lockfile, production deployment closure, non-root UID/GID 10001, explicit process entrypoint, and liveness check. `.dockerignore` explicitly excludes environment files, package-manager credentials, common key/credential files, local tooling, dependencies, caches, test output, and `skills-lock.json`. Secrets are runtime inputs; release automation must still build from a reviewed checkout rather than an arbitrary home directory.

## Rollout order

1. Back up PostgreSQL and record the candidate SHA/image digests.
2. Run `node dist/database/migrate.js` from the API candidate image as a separate one-shot job using a database-only migration identity. The command uses component-scoped configuration and does not require Redis, object-storage, provider, encryption, or signing secrets. The production image intentionally contains no pnpm/compiler toolchain.
3. Verify the migration ledger/checksums and application schema-aware readiness.
4. Roll API, relay, and worker independently with readiness gates and bounded termination grace periods longer than their configured drains.
5. Run the authenticated smoke and inspect error-budget/security signals.
6. Roll back application images if needed. Do not edit or automatically roll back an applied migration; use a new forward repair migration.

Ordinary service startup and HTTP handling never run migrations. Applied files are immutable and checksum-verified under a PostgreSQL advisory lock. Reconciliation indexes use individually ledgered `CREATE INDEX CONCURRENTLY` migrations on a dedicated connection with a 30-minute client/server deadline and a five-second lock deadline; a crash-created unledgered reserved index is recreated before the ledger advances. Incompatible changes use expand-and-contract: add compatible schema, deploy dual-compatible code, backfill, switch reads/writes, and remove obsolete schema in a later release.

## Proxy, TLS, and origins

Terminate TLS only at an approved edge or service mesh and use encrypted dependency links. Fastify does not trust `X-Forwarded-*` by default; enable trusted-proxy behavior only for explicitly enumerated proxy hops in a future platform-specific deployment layer. CORS is disabled by default. Relay credentials are Authorization headers, not query parameters, and the relay does not accept browser-cookie authentication.

The edge must bound header size, connection rate, and request lifetime in addition to application body/time limits. Do not expose PostgreSQL, Redis, worker health, migrations, reconciliation, or telemetry collectors publicly.

## Graceful replacement

- API: remove readiness at the platform edge, stop new requests, allow Fastify drain, then close PostgreSQL/Redis within the shutdown bound; a failed or timed-out close forces the process boundary after telemetry flush.
- Relay: stop upgrades, close client/upstream pairs and release ownership within `SURFGATE_RELAY_DRAIN_TIMEOUT_MS`.
- Worker: stop claiming, allow the current bounded operation to finish; if the drain expires, the database lease is left for safe recovery.

Use `SIGTERM`/`SIGINT`. Platform termination grace must exceed the application drain plus telemetry shutdown budget. Repeated shutdown signals do not start duplicate cleanup.
