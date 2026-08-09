# SurfGate Observability Specification

SurfGate must be debuggable without logging browser content.

Use OpenTelemetry-compatible traces/metrics and structured logs.

SG-0501 establishes the control-plane telemetry port and Fastify lifecycle hooks. HTTP
method, normalized route template, status, duration, and outcome are emitted without raw
URLs. Authentication emits only a bounded outcome/reason, database readiness emits its
normalized state, and session transitions expose bounded from/to/outcome fields. The
deployment-owned OpenTelemetry SDK/exporter bootstrap remains sequenced with Epic 9;
application/domain packages do not import a global exporter singleton.

SG-0504 adds bounded operation observations for quota checks, routing, provider allocation,
provider termination, and persistence-ready lifecycle events. Immutable audit rows cover
session create requested/succeeded/failed, routing decisions/fallback, termination outcomes,
quota denial, and policy denial. Provider payloads, target URLs, credentials, and connection
references are excluded.

---

## 1. Correlation fields

Internal context:

```text
request_id
trace_id
tenant_id
session_id
task_id
routing_decision_id
provider
runtime
```

Do not emit absent IDs as empty high-cardinality labels in metrics.

---

## 2. Trace spans

Recommended:

```text
surfgate.http.request
surfgate.auth.verify
surfgate.quota.check
surfgate.routing.decide
surfgate.provider.health
surfgate.provider.allocate
surfgate.provider.terminate
surfgate.relay.connect
surfgate.relay.upstream_connect
surfgate.session.persist
surfgate.task.execute
surfgate.artifact.store
```

Attributes should follow OTel semantic conventions where available.

Avoid raw query strings, authorization values, DOM, cookies.

---

## 3. Metrics

### Control plane

```text
surfgate_http_requests_total
surfgate_http_request_duration_seconds
surfgate_auth_failures_total
surfgate_rate_limit_denials_total
```

### Routing

```text
surfgate_routing_decisions_total{runtime,outcome}
surfgate_routing_duration_seconds
surfgate_routing_candidate_rejections_total{reason,runtime}
surfgate_fallback_total{from_runtime,to_runtime,outcome}
```

Do not label by raw domain globally unless cardinality/privacy policy explicitly permits it.

### Provider

```text
surfgate_provider_allocations_total{provider,runtime,outcome}
surfgate_provider_allocation_duration_seconds{provider,runtime}
surfgate_provider_health{provider,runtime}
surfgate_provider_errors_total{provider,runtime,error_class}
```

### Sessions

```text
surfgate_sessions_active{runtime,provider}
surfgate_sessions_created_total{runtime,provider}
surfgate_session_duration_seconds{runtime,provider}
surfgate_session_leaks_reconciled_total{provider,runtime}
```

### Relay

```text
surfgate_relay_connections_active
surfgate_relay_connections_total{outcome}
surfgate_relay_bytes_total{direction}
surfgate_relay_frames_total{direction}
surfgate_relay_backpressure_events_total
surfgate_relay_abnormal_closes_total{class}
```

### Tasks

```text
surfgate_tasks_total{type,outcome,runtime}
surfgate_task_duration_seconds{type,runtime}
surfgate_artifact_bytes_total{kind}
```

---

## 4. Structured events

Examples:

```json
{
  "event": "routing.decision",
  "requestId": "...",
  "sessionId": "...",
  "selectedRuntime": "kitesurf",
  "selectedProvider": "cloudflare-browser-run",
  "reasonCodes": ["CAPABILITIES_SATISFIED", "FAST_PATH_PREFERRED"],
  "policyVersion": "...",
  "durationMs": 4
}
```

Fallback:

```json
{
  "event": "routing.fallback.completed",
  "fromRuntime": "kitesurf",
  "toRuntime": "chromium",
  "failureClass": "PROVIDER_TRANSIENT",
  "outcome": "success"
}
```

---

## 5. Dashboards

### Executive reliability
- request success rate,
- session allocation success,
- fallback rescue,
- terminal failure,
- SLO burn.

### Provider
- Kitesurf/Chromium allocation latency,
- error class,
- health,
- selection share.

### Relay
- active connections,
- bytes/sec,
- event-loop lag,
- abnormal disconnect,
- memory.

### Security
- auth failures,
- policy denials,
- SSRF blocks,
- replayed relay tokens,
- cross-tenant denial attempts.

---

## 6. Alerts

Initial:
- API 5xx rate above threshold,
- provider allocation failure spike,
- all providers unavailable,
- relay abnormal close spike,
- session cleanup leak,
- Postgres/Redis unavailable,
- SSRF/security denial anomaly,
- SLO burn.

Avoid paging on every single provider transient failure.

---

## 7. Cardinality policy

Forbidden metric labels:
- full URL,
- request ID,
- session ID,
- task ID,
- user-agent,
- arbitrary error message.

These belong in traces/logs, not metrics.

---

## 8. Privacy

Normal observability MUST NOT contain page content.

Debug bundles require:
- explicit enablement,
- time-limited capture,
- retention,
- tenant access control,
- audit.
