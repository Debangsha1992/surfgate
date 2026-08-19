# Data recovery and reconciliation

## PostgreSQL

PostgreSQL is authoritative for tenants, API-key metadata, sessions, routing decisions, idempotency, tasks, artifact metadata, and audit events. Production requires encrypted automated backups, restricted backup access, retention aligned with legal policy, and point-in-time recovery where supported.

Run the local restore drill only against a database whose name ends in `_test`:

```bash
pnpm --filter @surfgate/api db:restore-drill
```

The drill creates a randomized temporary restore database, restores a custom-format dump without ownership/privileges, verifies the required migration through a bounded database query, and drops only the database it created. It requires version-compatible `pg_dump`, `pg_restore`, and `TEST_DATABASE_URL`. Each external command has a five-minute deadline and receives only the minimum PostgreSQL environment rather than the service's unrelated secrets. Record date, candidate SHA, restore duration, migration count, and operator.

This command is a local tooling/schema smoke: it dumps the configured test database immediately before restoring it and therefore does **not** prove that an automated production backup or PITR chain is usable. The release gate separately requires restoring an actual production backup/PITR artifact into an isolated environment, checking integrity/application invariants, recording backup age and recovery duration, and retaining the evidence. A successful local smoke or backup-only check is insufficient.

## Session reconciliation

Run as a private scheduled/one-shot job, never as a public endpoint:

```bash
node dist/reconcile.js
```

The bounded database-clock scan:

- fails stale `pending`, `routing`, `allocating`, and `fallback_allocating` sessions and finalizes their idempotency record;
- records uncertain provider-allocation exposure without replaying allocation;
- retries idempotent provider termination for stale `terminating` sessions;
- terminates expired `active` sessions using protected provider references;
- uses versioned compare-and-set transitions, tenant-bound encrypted context, provider timeouts, deterministic order, and bounded batches.

An unresolved count makes the job fail so the scheduler/alert can retry. Never manually mark an uncertain provider session terminated without provider evidence. Inspect provider inventory by account/profile and rely on bounded provider session TTL for allocations lost before SurfGate receives a reference.

## Tasks and artifacts

Expired PostgreSQL worker leases are claimable again and stale owners cannot commit. This is at-least-once read-only task execution, not exactly once. Attempt-unique object keys prevent a retry from silently replacing another attempt. Known losing attempts delete their object; private bucket lifecycle rules remove expired objects and bound uncertain orphans.

Artifact bytes are not authoritative business data. PostgreSQL artifact metadata is authoritative for authorization and integrity. Configure private access, encryption, lifecycle expiry matching `SURFGATE_TASK_ARTIFACT_RETENTION_SECONDS`, inventory, and alarms for metadata/object mismatch. Do not restore an object into public access or return unverified bytes.

## Redis restart

Redis contains reconstructable rate-limit windows and security-critical temporary relay coordination/revocation. It is not authoritative for sessions, routing, tasks, artifacts, or audits.

- During outage, API rate-limit checks and new relay authorization fail closed; existing relay connections close within their bounded authorization interval when consistency cannot be proven.
- After restart, ephemeral counters/leases rebuild. Durable session state is re-read from PostgreSQL.
- Termination publishes revocation again as part of normal lifecycle; short token TTL and durable non-connectable session state prevent stale authorization from becoming durable access.

Verify PostgreSQL state, Redis readiness, relay rejection/acceptance, quota isolation, and no active ownership leaks after recovery.
