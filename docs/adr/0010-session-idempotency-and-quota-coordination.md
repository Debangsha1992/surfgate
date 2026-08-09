# ADR 0010: Durable Session Idempotency and Quota Coordination

- Status: accepted
- Date: 2026-08-09

## Context

Session allocation crosses PostgreSQL, Redis, and an external provider. Concurrent retries
must not allocate twice, quota checks must be race-safe, and no database transaction may stay
open across provider network calls.

## Decision

PostgreSQL is authoritative for the idempotency scope `(tenant, method, normalized endpoint,
key)`, semantic request hash, intermediate session, routing decision, allocation attempts, and
final result. Creation takes a tenant-scoped transaction advisory lock, reserves concurrency,
and commits `PENDING` plus the idempotency claim before routing or provider I/O. State changes
then use the existing compare-and-set session reducer in short transactions.

Redis implements only the atomic per-tenant fixed-window request-rate limit. Redis failure
fails creation closed and readiness reports unavailable; it never erases PostgreSQL history or
becomes the only source of session, routing, idempotency, or audit truth.

A duplicate semantic request waits for the durable owner for a bounded period. A different
body returns the stable idempotency conflict. A stalled claim in or after allocation is not
blindly stolen because the upstream side effect may have succeeded; reconciliation must inspect
the durable attempt/session state. One classified cross-runtime fallback is recorded as attempt
one, and no third allocation is possible under the schema or router policy.

## Consequences

- Normal concurrent/replayed requests cannot independently allocate.
- Provider calls never run inside a PostgreSQL transaction.
- Redis outages deny creation instead of bypassing quotas.
- Recovery of an uncertain post-allocation crash requires reconciliation rather than unsafe
  automatic replay.
- Audit records are append-only through repository APIs and reject direct mutation; controlled
  tenant retention cascades remain possible.
