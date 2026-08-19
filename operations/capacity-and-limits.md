# Capacity, timeout, retry, and retention policy

## Capacity evidence

`pnpm test:capacity` composes deterministic router/session/worker contention coverage with the developer-safe relay load harness. The relay harness exercises 20 concurrent controllers, 400 ordered frames, slow consumers, abrupt disconnects, event-loop delay, RSS delta, throughput, and leaked ownership. It is a regression envelope, not a production capacity claim. Establish deployment-specific saturation thresholds by load-testing the chosen PostgreSQL, Redis, provider account, object store, CPU, and network topology.

Scale against bounded signals: PostgreSQL acquisition/queries, Redis latency, provider allocation/capacity, active relay connections/queued bytes, worker queue/leases, artifact latency/bytes, event-loop delay, RSS/heap, and error-budget burn. Stop a capacity test before safety quotas are removed or real provider side effects become unbounded.

## Pools and connection ownership

- API, relay, and worker PostgreSQL pools are independently bounded at 10 connections with five-second connection acquisition, query/statement timeouts, idle cleanup, and 30-minute connection lifetime.
- Each process owns a bounded Redis client; relay ownership has TTL/renewal and release semantics.
- Provider operations use explicit AbortSignal/timeout budgets and no unbounded retries.
- Relay WebSockets disable compression, cap frames/queued bytes, enforce one controller per session, and close both directions on limits.
- Worker concurrency is configured, database-leased, and constrained to one running task per session.
- One object-storage client is reused per process; upload/read sizes and execution deadlines are bounded.

## Timeout hierarchy

| Operation                              |                         Default bound | Notes                                          |
| -------------------------------------- | ------------------------------------: | ---------------------------------------------- |
| API connection/request                 |                             10s / 30s | Body is capped at 1 MiB                        |
| DNS target policy                      |               bounded resolver policy | All bounded answers checked and revalidated    |
| Provider health/allocation/termination |                        5s / 30s / 15s | Cleanup uses an independent termination budget |
| PostgreSQL connect/query/statement     |                          5s / 6s / 5s | Pool size 10                                   |
| Redis operation/shutdown               | bounded client command / forced close | Security paths fail closed                     |
| Relay connect/idle/absolute            |                        10s / 60s / 1h | Also cannot outlive session                    |
| Worker execution/lease/drain           |                       30s / 60s / 10s | Lease exceeds execution by at least 15s        |
| Artifact output                        |   execution deadline + 16 MiB default | Integrity checked on access                    |
| Telemetry export/shutdown              |                               5s / 5s | Queue 2048, batch 512, cardinality cap 128     |

Outer request cancellation does not cancel independent post-allocation cleanup. Deployment termination grace must exceed the configured service drain and telemetry flush.

## Retry inventory

| Operation               | Attempts/backoff                                         | Idempotency and side-effect policy                                                               |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Session allocation      | Selected runtime plus at most one cross-runtime fallback | Only classified pre-interaction allocation failure; never active-session migration/action replay |
| Provider transport      | No hidden retry loop                                     | Caller owns bounded fallback/classification                                                      |
| Session termination     | Caller/reconciler retries later                          | Provider termination is idempotent; already-gone is success                                      |
| Managed task            | Up to 3 attempts, durable `next_attempt_at` policy       | At-least-once; attempt-unique artifacts; no exactly-once claim                                   |
| Relay ownership renewal | Periodic bounded lease renewal                           | Loss closes transport; no provider fallback                                                      |
| Telemetry export        | SDK bounded queue/batch behavior                         | Never blocks serving or replaces durable audit                                                   |

No HTTP/service/provider nested retry multiplication is permitted.

## Retention classes

- **Durable:** tenants, API-key metadata, sessions, routing decisions, task/audit records, and migration ledger. Product/legal policy must define archive/deletion; immutable audit events require an approved retention job rather than ad hoc deletion.
- **Temporary durable:** artifact metadata and private objects, with configurable 60-second to one-year lifetime (default one day).
- **Ephemeral:** Redis rate windows, relay ownership/revocation, traces, metrics, and operational logs. Relay revocation entries expire; relay tokens last at most five minutes.
- **Cleanup eligible:** terminal sessions/routing/tasks after policy retention, expired artifacts, completed idempotency records, and operational telemetry after its platform retention. Cleanup is tenant-safe, batched, audited where required, and never deletes active state.
