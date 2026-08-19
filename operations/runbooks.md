# SurfGate Operational Runbooks

Use stable event names, metric dimensions, trace IDs, and normalized error codes. Never paste credentials, raw CDP payloads, target URLs, page content, provider-session references, or signed artifact URLs into incident systems.

## PostgreSQL unavailable

- **Symptom:** API, relay, or worker readiness is `not_ready`; `postgresql` dependency readiness is 0.
- **Signals:** dependency probe latency, connection-pool/statement timeout errors, API 5xx, task queue inactivity.
- **Investigate:** confirm database service health and saturation, network/TLS reachability, pool exhaustion, recent migration status, and storage capacity.
- **Mitigate:** stop new work through readiness/load balancing; restore PostgreSQL or fail over using the deployment's tested procedure. Do not bypass tenant-scoped persistence.
- **Verify:** migrations are consistent, all component readiness probes recover, a test session/task lifecycle persists, and reconciliation handles interrupted work.
- **Escalate:** data integrity, migration checksum mismatch, repeated failover, or recovery beyond the API availability budget.

## Redis unavailable

- **Symptom:** API/relay readiness fails, rate-limit/idempotency coordination errors rise, or relay authorization fails closed.
- **Signals:** `redis` readiness 0, Redis latency, relay auth failures, quota dependency errors.
- **Investigate:** Redis health, memory/eviction, connectivity/TLS, reconnect exhaustion, and Pub/Sub delivery.
- **Mitigate:** restore or fail over Redis. Never disable revocation, controller ownership, quota, or idempotency checks to regain availability.
- **Verify:** readiness recovers, a duplicate idempotent create is single-allocation, and relay termination revocation reaches another instance.
- **Escalate:** possible split brain, lost revocation consistency, or recurring memory pressure.

## Provider unavailable

- **Symptom:** Kitesurf or Chromium health becomes unavailable, allocations fail, or fallback increases.
- **Signals:** provider health/allocation metrics by bounded provider/runtime and stable error code, routing rejection reasons, Cloudflare status outside SurfGate.
- **Investigate:** server-side provider configuration, account capacity/rate limit, network reachability, and normalized request IDs. Do not inspect or expose tokens.
- **Mitigate:** let deterministic routing use the healthy compatible runtime. If both providers are unavailable, reject new sessions; never migrate an active CDP session.
- **Verify:** health is healthy/degraded as expected, allocation succeeds, fallback returns to baseline, and leaked-session reconciliation is clear.
- **Escalate:** both runtimes unavailable, provider auth failure, or sustained budget burn.

## API or session-creation failures

- **Symptom:** API 5xx or valid session-create failure/latency rises.
- **Signals:** route-template HTTP metrics, auth/quota/idempotency spans, routing decision, provider allocation, session transitions, dependency readiness.
- **Investigate:** follow one request trace through auth, quota, idempotency, routing, provider, and persistence. Distinguish expected 4xx denials from service errors.
- **Mitigate:** restore the failing dependency/provider or reduce admitted load. Preserve durable intermediate states; do not retry blindly after uncertain allocation.
- **Verify:** idempotent retry returns the same result, no duplicate provider session exists, and active-session counts reconcile.
- **Escalate:** uncertain provider cleanup, cross-tenant anomaly, or error-budget burn.

## Relay failures or backpressure

- **Symptom:** connection failures, upstream latency, abnormal closes, or backpressure events rise.
- **Signals:** relay auth/upstream spans, active connections, directional bytes/frames, close reason, Redis/PostgreSQL readiness.
- **Investigate:** separate authentication/session-state denial, distributed ownership conflict, upstream connect failure, slow client, and slow upstream.
- **Mitigate:** drain unhealthy relay instances; scale within tested limits; restore dependencies. Do not increase queue/message limits without load evidence and memory review.
- **Verify:** new connections succeed, active counts return to zero after drain, memory stabilizes, and no provider credential appears in client traffic/logs.
- **Escalate:** leaked connections, repeat backpressure at normal traffic, or provider-wide upstream failure.

## Task backlog, stuck work, or retries

- **Symptom:** queue latency grows, `running` tasks remain past lease, retries or lease recovery rise.
- **Signals:** task queue/execution histograms, active tasks, retry/failure codes, PostgreSQL readiness, worker readiness and shutdown events.
- **Investigate:** worker capacity, provider session expiry, lease deadlines, executor timeouts, one-running-task-per-session contention, and object storage.
- **Mitigate:** restore workers/dependencies and scale within database/provider capacity. Let expired leases be reclaimed; do not manually mark success or claim exactly-once browser execution.
- **Verify:** queue drains, running count matches claims, retries stop growing, and terminal/audit state is consistent.
- **Escalate:** repeated non-idempotent browser side effects, claim corruption, or max-attempt exhaustion spike.

## Artifact storage unavailable

- **Symptom:** screenshot/PDF tasks fail after execution or authorized artifact access returns unavailable.
- **Signals:** object-storage readiness, artifact upload/access spans, size histogram, integrity failures, cleanup warnings.
- **Investigate:** bucket policy/private access, endpoint/TLS, credentials in deployment secret storage, capacity, retention policy, and object/database consistency.
- **Mitigate:** stop artifact-producing work through worker readiness if storage is unavailable; restore storage. Never place artifact bytes in PostgreSQL or logs.
- **Verify:** bounded upload/read/integrity check succeeds, tenant authorization holds, and uncertain objects are reconciled.
- **Escalate:** possible public access, integrity mismatch, tenant isolation concern, or persistent orphan growth.

## Telemetry exporter unavailable

- **Symptom:** collector/export failures or a gap in traces/metrics while services remain ready.
- **Signals:** collector health and network telemetry, configured bounded export timeout/queue, structured lifecycle logs.
- **Investigate:** collector endpoint/TLS, network policy, collector capacity, and deployment configuration. Do not log exporter authorization material.
- **Mitigate:** restore or scale the collector. SurfGate should continue serving with bounded drops; do not make OTLP a security/readiness dependency.
- **Verify:** exports resume, application latency did not track exporter latency, memory is stable, and shutdown flush stays bounded.
- **Escalate:** telemetry causes request blocking, memory growth, secret exposure, or sustained loss during another incident.

## Graceful shutdown

- **Symptom:** deployment drain stalls or active work remains after termination starts.
- **Signals:** `*.shutdown.initiated`, drain-timeout, dependency-timeout, and shutdown-complete events plus active session/relay/task gauges.
- **Investigate:** active HTTP requests, relay pairs, task execution deadline, database/Redis close, and exporter flush.
- **Mitigate:** keep readiness removed, wait only for configured bounds, then allow bounded forced transport cleanup. Provider/session reconciliation remains authoritative.
- **Verify:** process exits, relay/task active gauges return to zero, controller leases expire/release, and replacement instances are ready.
- **Escalate:** leaked upstream sessions, stuck leases, or shutdown repeatedly exceeds the deployment termination grace period.
