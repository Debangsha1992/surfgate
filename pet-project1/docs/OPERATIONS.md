# SurfGate Operations Runbook

## 1. Service health

Check in order:

1. API health
2. Postgres
3. Redis
4. relay service
5. provider health
6. worker queue
7. object storage

Do not diagnose provider issues from aggregate 5xx alone. Inspect normalized error class.

Control-plane probes:

```text
/health/live   process liveness; never depends on providers or PostgreSQL
/health/ready  readiness; requires PostgreSQL and Redis and returns 503 when either is unavailable
```

Health responses expose normalized state only. They never expose connection strings,
provider diagnostics, SQL, or exception details.

### Database migrations

Migrations are a deployment step and never run in the request-serving process:

```bash
pnpm --filter @surfgate/api db:migrate
```

Run an additive migration before deploying code that requires it. The runner serializes
with a PostgreSQL advisory lock and rejects a checksum change to an already applied
migration. Do not edit an applied migration; add the next numbered SQL file. Use a
separate migration role from the runtime role where practical.

### Stalled idempotency and uncertain cleanup

An in-progress idempotency row whose lease elapsed after the session reached an allocation
state is not automatically reallocated. Treat it as reconciliation work: inspect the durable
session/allocation-attempt history, verify the upstream session without exposing its protected
reference, terminate an orphan if present, and complete the durable record. Never clear the
claim and blindly replay allocation.

---

## 2. Provider incident

Symptoms:
- allocation failures,
- high latency,
- provider-specific 5xx,
- rate limiting.

Action:
1. verify health probe,
2. inspect provider error class,
3. open circuit if automatic breaker has not,
4. confirm router selects compatible alternative,
5. monitor fallback load,
6. avoid relaxing capability/security rules just to restore traffic.

---

## 3. Kitesurf compatibility regression

1. identify capability/domain/task class,
2. mark compatibility degraded through approved policy,
3. route affected workload to Chromium,
4. add regression fixture,
5. update provider conformance/compatibility test,
6. only restore Kitesurf when verified.

---

## 4. Session leak

A leak means SurfGate terminal/expired session with upstream runtime still alive.

Reconciliation:
- find expired/terminal rows with provider ref,
- issue idempotent terminate,
- record outcome,
- increment leak metric,
- clear ref when safe according to retention policy.

Never rely only on process shutdown cleanup.

---

## 5. Signing-key rotation

Relay signing keys:
- support key ID,
- accept current + previous during bounded transition,
- sign only with current,
- remove previous after maximum token lifetime + margin.

Provider-session encryption uses a separate AES-256-GCM key ID and key. Until a bounded
read key ring/KMS integration exists, do not replace the active production key in place;
perform a reviewed re-encryption/rotation change that can read the prior key during the
transition. API-key scrypt hashes do not use this encryption key.

---

## 6. API key compromise

- revoke key,
- audit,
- issue replacement,
- inspect recent actions,
- do not rotate unrelated tenant keys unless required.

---

## 7. Data retention

Define per environment:
- session metadata,
- routing decisions,
- audit,
- artifacts,
- debug bundles.

Debug content must have shortest retention.

---

## 8. Deployment

Safe order for compatible releases:

1. database additive migration,
2. deploy backward-compatible services,
3. enable feature flag/policy,
4. verify metrics,
5. cleanup migration in later release.

Avoid deploys requiring all services to switch simultaneously.

---

## 9. Rollback

Code rollback must not assume DB migration can be reversed.

Prefer forward-compatible schema changes.

For routing regressions, policy/config rollback should be possible without code deploy.

---

## 10. On-call alerts

Page:
- control-plane SLO burn,
- all runtime providers unavailable,
- cross-tenant/security invariant breach,
- session leak surge,
- relay fleet saturation.

Ticket/non-page:
- isolated provider transient errors,
- minor compatibility changes,
- non-critical debug artifact failure.
