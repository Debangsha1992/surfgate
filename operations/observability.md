# SurfGate Observability and Service Objectives

This is the production operator contract for SurfGate's API, relay, and worker. It describes implemented telemetry and initial internal objectives; it is not a customer SLA.

## Telemetry architecture

All three services initialize `@surfgate/observability`. With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, telemetry remains backend-free. With it set, the shared runtime exports traces and metrics over OTLP/HTTP using one concurrent export, bounded span and metric batches, finite exporter timeouts, and a finite shutdown flush. Exporter failure is non-fatal and never changes authorization or readiness.

Service names are `<OTEL_SERVICE_NAME>-api`, `<OTEL_SERVICE_NAME>-relay`, and `<OTEL_SERVICE_NAME>-worker`. Incoming API and relay requests accept W3C `traceparent`. A managed task stores only one validated `traceparent` string so a worker span can continue the async flow; baggage, arbitrary headers, and full trace payloads are not persisted.

Audit events remain durable business/security records. Telemetry does not replace or modify them.

## Span taxonomy

- `surfgate.http.request`, `surfgate.auth.verify`, `surfgate.quota.check`, and `surfgate.idempotency.resolve`
- `surfgate.routing.decide`, `surfgate.routing.fallback`, and `surfgate.session.persist`
- `surfgate.provider.health`, `surfgate.provider.allocate`, and `surfgate.provider.terminate`
- `surfgate.relay.authenticate`, `surfgate.relay.upstream_connect`, and `surfgate.relay.connection`
- `surfgate.task.create`, `surfgate.task.claim`, `surfgate.task.execute`, and `surfgate.task.retry`
- `surfgate.artifact.store` and `surfgate.artifact.access`

Attributes are allowlisted and bounded: route template, method, status family, outcome, stable reason code, provider, runtime, task type, attempt, direction, fallback, and policy/lifecycle state. Domain and request IDs may be used in already-redacted structured logs or traces for incident correlation, but never as metric dimensions.

## Metrics

| Metric                                                                                                   | Purpose                                                           |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `surfgate.http.requests`, `surfgate.http.request.duration`                                               | API volume, status-family outcome, and route-template latency     |
| `surfgate.auth.attempts`                                                                                 | Authentication success and bounded denial category                |
| `surfgate.dependency.ready`, `surfgate.dependency.health.duration`                                       | PostgreSQL, Redis, and object-storage readiness                   |
| `surfgate.operation.attempts`, `surfgate.operation.duration`                                             | Quota, idempotency, routing, provider, and persistence operations |
| `surfgate.routing.decisions`, `surfgate.routing.candidate_rejections`                                    | Selected/no-compatible outcomes and stable rejection reasons      |
| `surfgate.session.transitions`, `surfgate.session.active`                                                | Session lifecycle and active population                           |
| `surfgate.relay.connections`, `surfgate.relay.active_connections`                                        | Relay attempts, closes, failures, and active controllers          |
| `surfgate.relay.bytes`, `surfgate.relay.frames`                                                          | Directional relay traffic without payload inspection              |
| `surfgate.task.events`, `surfgate.task.duration`, `surfgate.task.queue.duration`, `surfgate.task.active` | Queue, execution, retries, outcomes, and running work             |
| `surfgate.artifact.bytes`                                                                                | Artifact size and successful/failed storage or access events      |

Latency histograms use millisecond buckets from 5 ms through 60 seconds. Artifact-size histograms use 1 KiB through 64 MiB buckets. The runtime caps aggregated series per instrument. Labels must never include tenant, session, task, request, artifact, trace, URL, hostname, user metadata, or arbitrary error text. Unknown HTTP paths become `unmatched`; resource IDs never become route labels.

## Health semantics

- Liveness answers only whether the process can serve the probe.
- API readiness requires PostgreSQL and Redis because requests cannot safely preserve persistence, idempotency, quota, and relay revocation semantics without them.
- Relay readiness requires PostgreSQL session state and Redis authorization/ownership state. It fails closed when either cannot be proven.
- Worker readiness requires PostgreSQL task state and object storage. Draining removes readiness before work stops.
- Provider degradation is routing input, not process liveness. One unavailable runtime does not make the API dead.
- OTLP exporter failure is observable but never a readiness dependency.

Health bodies contain only normalized dependency names and `ready`/`unavailable`; they never contain topology, URLs, credentials, or raw diagnostics.

## Initial proposed SLIs and SLOs

These are initial internal targets for a rolling 28-day window and must be recalibrated with production data.

| SLI                 | Eligible events and success                                                                                                      | Proposed SLO                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| API availability    | Non-health requests excluding authentication, validation, policy, quota, and tenant-safe not-found responses; success is non-5xx | 99.9%                                         |
| Session creation    | Valid, authorized, quota-admitted creates; success is an active session                                                          | 99.0% and p95 under 20 s                      |
| Routing             | Valid routing evaluations; success is a completed deterministic decision                                                         | 99.99% and p95 under 100 ms                   |
| Provider allocation | Attempts against configured, routing-eligible providers; success is normalized allocation                                        | 99.0%                                         |
| Relay connection    | Authorized connect attempts for active sessions; success is upstream established                                                 | 99.5% and upstream-connect p95 under 3 s      |
| Managed task        | Supported tasks admitted within quota; success is terminal `succeeded`                                                           | 99.0% and p95 queue-plus-execution under 60 s |
| Artifact storage    | Artifact-producing executions; success is durable object plus committed metadata                                                 | 99.9%                                         |

For objective `S`, the error budget is `eligible_events × (1 - S)`. Expected client denials are excluded only where listed; provider, dependency, timeout, internal, lease-recovery exhaustion, and artifact failures consume budget. Report numerator, denominator, exclusions, and low-volume confidence together.

## Alert specification

The vendor-neutral machine-readable alert catalog is [alerts.yaml](alerts.yaml). Page on multi-window symptom burn, critical dependency unavailability, or resource saturation. Ticket on sustained provider degradation, retry growth, or telemetry loss. Do not alert on one expected client failure.

## Dashboard specification

1. **Overview:** request/session/task/relay success, SLO burn, active sessions/connections/tasks, and dependency readiness.
2. **Control plane:** route-template latency/status, auth/quota/idempotency outcomes, session transitions, PostgreSQL and Redis latency.
3. **Routing/providers:** selected runtime/provider, rejection reasons, fallback outcomes, health, allocation and termination latency/errors.
4. **Relay:** attempts, authorization denials, upstream latency, active controllers, bytes/frames, backpressure, abnormal and timeout closes.
5. **Tasks/workers:** queued/running outcomes, queue/execution latency, retries, lease recovery, artifact latency/size/failure.
6. **Dependencies:** PostgreSQL, Redis, object storage, and OTLP export health at deployment/collector level.
7. **Security denials:** bounded authentication, policy, quota, relay authorization, and SSRF denial codes without target data.

Use traces for request-specific diagnosis and metrics for fleet-level symptoms. Never display raw CDP frames, page content, extracted text, signed URLs, cookies, or credentials.
