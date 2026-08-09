# SurfGate API Contract — v1 Draft

This document describes intended product behavior. Implemented source schemas in `packages/contracts` are authoritative.

Base:

```text
https://api.example.com/v1
```

All JSON responses include a request ID through header:

```text
X-Request-ID
```

---

## 1. Authentication

MVP:

```http
Authorization: Bearer sg_live_...
```

API keys are tenant-scoped.

Do not accept credentials in query strings.

SurfGate keys use `sg_live_<12-hex-prefix>_<32-byte-base64url-secret>` or the
corresponding `sg_test_` form. The complete value is returned only at issuance. Durable
metadata contains its globally unique non-secret prefix, a versioned salted scrypt hash,
scopes, expiry, and revocation timestamps. Subsequent reads never return the secret or
hash. Missing credentials use `AUTH_UNAUTHORIZED`; malformed, unknown, incorrect,
expired, revoked, and inactive-tenant credentials are externally normalized so prefix or
tenant existence is not disclosed. Scope denial uses `AUTH_FORBIDDEN`.

### Control-plane health

The unauthenticated process probes are outside `/v1`:

```text
GET /health/live   -> 200 while the process can serve requests
GET /health/ready  -> 200 only when required control-plane dependencies are ready
```

Readiness currently requires PostgreSQL. It returns `503` with only normalized dependency
state when PostgreSQL is unavailable. A provider outage does not make the API process
unhealthy. Neither response contains connection strings, SQL, stack traces, or provider
diagnostics.

### SurfGate identifiers

SurfGate identifiers are opaque strings with a type-specific prefix and a
26-character uppercase Crockford ULID suffix. Clients must not derive business
meaning from the suffix.

```text
TenantID            ten_<ULID>
APIKeyID            key_<ULID>
SessionID           ses_<ULID>
RoutingDecisionID   rtd_<ULID>
TaskID              tsk_<ULID>
ArtifactID          art_<ULID>
RequestID           req_<ULID>
```

The schemas in `packages/contracts` validate these shapes and expose distinct
branded TypeScript types so one ID category cannot be substituted for another.

---

## 2. Error shape

```json
{
  "error": {
    "code": "ROUTING_NO_COMPATIBLE_RUNTIME",
    "message": "No runtime satisfies the requested capabilities.",
    "requestId": "req_01...",
    "details": {
      "rejectedCandidates": ["kitesurf"]
    }
  }
}
```

Stable error families:

```text
AUTH_*
VALIDATION_*
POLICY_*
QUOTA_*
ROUTING_*
PROVIDER_*
SESSION_*
RELAY_*
TASK_*
ARTIFACT_*
INTERNAL_*
```

The initial stable codes are:

```text
AUTH_INVALID_CREDENTIALS
AUTH_UNAUTHORIZED
AUTH_FORBIDDEN
VALIDATION_INVALID_REQUEST
VALIDATION_INVALID_ID
VALIDATION_UNSUPPORTED_CAPABILITY
VALIDATION_IDEMPOTENCY_CONFLICT
POLICY_DENIED
POLICY_TARGET_FORBIDDEN
QUOTA_EXCEEDED
QUOTA_CONCURRENT_SESSION_LIMIT
ROUTING_NO_COMPATIBLE_RUNTIME
ROUTING_FALLBACK_EXHAUSTED
PROVIDER_UNAVAILABLE
PROVIDER_AUTHENTICATION_FAILED
PROVIDER_RATE_LIMITED
PROVIDER_TIMEOUT
PROVIDER_UPSTREAM_ERROR
SESSION_NOT_FOUND
SESSION_NOT_ACTIVE
SESSION_EXPIRED
SESSION_INVALID_TRANSITION
RELAY_UNAUTHORIZED
RELAY_TOKEN_EXPIRED
RELAY_CONNECTION_FAILED
TASK_NOT_FOUND
TASK_FAILED
ARTIFACT_NOT_FOUND
ARTIFACT_UNAVAILABLE
INTERNAL_ERROR
INTERNAL_DATABASE_UNAVAILABLE
```

Public error payloads are runtime validated. Each code has one canonical public
message. `details`, when present, is a strict allowlisted object. The initial
contract allows only `rejectedCandidates`, containing `kitesurf` and/or
`chromium`; future detail fields require a deliberate code-specific schema
addition. Stack traces, secrets, authorization data, raw provider errors,
internal hostnames, arbitrary fields, and prototype-pollution keys are therefore
rejected by the public schema.

---

## 3. POST /v1/sessions

Creates and allocates a browser session.

Headers:

```http
Idempotency-Key: required
```

Request:

```json
{
  "targetUrl": "https://example.com",
  "capabilities": {
    "javascript": "required",
    "screenshot": "required",
    "webgl": "not_required",
    "persistentAuth": "not_required"
  },
  "runtime": {
    "preference": "auto",
    "allowFallback": true,
    "allowExperimental": false
  },
  "maxDurationSeconds": 120,
  "metadata": {
    "application": "research-agent"
  }
}
```

`runtime.preference`:

```text
auto
kitesurf
chromium
```

A preference is not an instruction to violate capabilities or policy.

Capability request states are exactly:

```text
required
preferred
not_required
```

`required` is a hard eligibility constraint. `preferred` may influence future
routing but never makes a candidate ineligible. `not_required` has no eligibility
effect. Experimental support satisfies `required` only when
`runtime.allowExperimental` is `true`.

If a caller requires a runtime with no fallback:

```json
{
  "runtime": {
    "preference": "kitesurf",
    "allowFallback": false
  }
}
```

Response 201:

```json
{
  "session": {
    "id": "ses_01...",
    "status": "active",
    "runtime": {
      "runtimeClass": "kitesurf",
      "providerId": "cloudflare-browser-run"
    },
    "routing": {
      "decisionId": "rtd_01...",
      "reasonCodes": ["CAPABILITIES_SATISFIED", "FAST_PATH_PREFERRED"],
      "fallbackOccurred": false
    },
    "createdAt": "2026-08-07T13:00:00Z",
    "connectedAt": "2026-08-07T13:00:01Z",
    "expiresAt": "2026-08-07T13:02:00Z",
    "terminatedAt": null
  }
}
```

Epic 6 has not implemented the SurfGate relay. The v1 response intentionally omits
relay URLs/tokens and never returns the upstream provider WebSocket. Relay connection
material will be added only with a version-compatible public contract in Epic 6.

---

## 4. GET /v1/sessions/{id}

Response:

```json
{
  "session": {
    "id": "ses_01...",
    "status": "active",
    "runtime": { "runtimeClass": "chromium", "providerId": "cloudflare-browser-run" },
    "routing": {
      "decisionId": "rtd_01...",
      "reasonCodes": ["CAPABILITIES_SATISFIED"],
      "fallbackOccurred": false
    },
    "createdAt": "2026-08-07T13:00:00Z",
    "connectedAt": "2026-08-07T13:00:02Z",
    "expiresAt": "2026-08-07T13:05:00Z",
    "terminatedAt": null
  }
}
```

Does not return relay/provider secrets on subsequent reads.

---

## 5. POST /sessions/{id}/relay-token

Issues/reissues a short-lived SurfGate relay credential if:

- session active,
- caller authorized,
- policy permits,
- session not near/after expiry.

Response:

```json
{
  "webSocketUrl": "wss://relay.example.com/v1/sessions/ses_01.../cdp",
  "token": "...",
  "expiresAt": "..."
}
```

---

## 6. DELETE /v1/sessions/{id}

Idempotently terminates.

Response:

```json
{
  "session": {
    "id": "ses_01...",
    "status": "terminated",
    "runtime": { "runtimeClass": "chromium", "providerId": "cloudflare-browser-run" },
    "routing": { "decisionId": "rtd_01...", "reasonCodes": ["CAPABILITIES_SATISFIED"], "fallbackOccurred": false },
    "createdAt": "...",
    "connectedAt": "...",
    "expiresAt": "...",
    "terminatedAt": "..."
  }
}
```

Repeated delete returns the terminal state rather than failing.

---

## 7. WebSocket /sessions/{id}/cdp

Authentication options:

- `Authorization` header when client supports custom headers,
- protocol/subprotocol token mechanism if required by a supported client.

Avoid tokens in normal URL query strings. If compatibility forces query tokens, make them:

- one-time,
- extremely short-lived,
- redacted at ingress,
- documented as less preferred.

Relay semantics:

- one session token is scoped to one SurfGate session,
- token cannot open another session,
- token cannot outlive session,
- server closes on revoke/expiry/termination.

---

## 8. POST /tasks

Managed task API.

Request:

```json
{
  "type": "extract",
  "target": {
    "url": "https://example.com"
  },
  "runtime": {
    "preference": "auto",
    "allowFallback": true
  },
  "limits": {
    "timeoutSeconds": 30
  },
  "input": {
    "selector": "main"
  }
}
```

Task types MVP:

```text
extract
screenshot
pdf
```

Response can be synchronous for short operations or return `202` with a task ID depending API mode selected in implementation.

Preferred long-term model:

```text
POST /tasks -> 202
GET /tasks/{id}
```

---

## 9. GET /tasks/{id}

```json
{
  "id": "tsk_01...",
  "status": "succeeded",
  "runtime": {
    "class": "kitesurf",
    "provider": "cloudflare-browser-run"
  },
  "routing": {
    "fallbackOccurred": false
  },
  "result": {
    "kind": "extract",
    "content": {
      "text": "..."
    }
  },
  "createdAt": "...",
  "completedAt": "..."
}
```

Large results become artifacts rather than inline JSON.

---

## 10. Artifact endpoint

Recommended:

```text
GET /artifacts/{id}
```

Returns metadata and a short-lived signed object URL after authorization.

Do not expose raw storage bucket paths publicly.

---

## 11. Idempotency

For create endpoints:

Key scope:

```text
tenant + HTTP method + normalized route + idempotency key
```

Store a request-body hash.

Same key + same semantic body:

- return prior result.

Same key + different body:

- `409 VALIDATION_IDEMPOTENCY_CONFLICT`.

The durable PostgreSQL claim is created atomically with the `PENDING` session under a
tenant advisory lock. A concurrent equivalent request waits for the owner and never
allocates independently. If the bounded wait expires while the owner remains in progress,
SurfGate returns a dependency-unavailable error; it does not guess or allocate again.

---

## 12. Pagination

Cursor-based.

```text
GET /sessions?limit=50&cursor=...
```

Response:

```json
{
  "data": [],
  "nextCursor": null
}
```

---

## 13. Rate-limit headers

Recommended:

```text
RateLimit-Limit
RateLimit-Remaining
RateLimit-Reset
Retry-After
```

---

## 14. Versioning

Use `/v1`.

Within v1:

- additive optional fields are allowed,
- enum expansion must be treated carefully by SDKs,
- removing/renaming fields is breaking,
- changing stable error semantics is breaking.

---

## 15. OpenAPI

OpenAPI MUST be generated from or tightly coupled to runtime schemas.

CI should detect drift.

The SDK should be tested against the published contract.
