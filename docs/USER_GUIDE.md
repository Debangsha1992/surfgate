# User and API Guide

The API listens on `http://127.0.0.1:8080` by default. Runtime schemas are the source of truth; inspect `GET /openapi.json` for the complete current contract.

## Authentication

Send a tenant-scoped SurfGate key in every protected HTTP request:

```http
Authorization: Bearer sg_test_...
```

Keys are shown only when issued. SurfGate stores a scrypt hash and lookup prefix, not the plaintext secret. Endpoints also enforce scopes such as `sessions:write`, `sessions:connect`, `tasks:write`, and `artifacts:read`.

## Sessions

Create a session with a unique `Idempotency-Key`:

```bash
curl --fail-with-body http://127.0.0.1:8080/v1/sessions \
  -H "Authorization: Bearer $SURFGATE_API_KEY" \
  -H 'Idempotency-Key: demo-session-1' \
  -H 'Content-Type: application/json' \
  --data '{
    "capabilities": {"javascript":"required","dom":"required"},
    "runtime": {"preference":"auto","allowFallback":true,"allowExperimental":false},
    "maxDurationSeconds": 600,
    "metadata": {"application":"example","tags":["docs"]}
  }'
```

Capability values are `required`, `preferred`, or `not_required`. Current capability names are `javascript`, `dom`, `xhr`, `svg`, `screenshot`, `pdf`, `webgl`, `video`, `persistentAuth`, `realBrowserTLS`, `downloads`, `uploads`, `multiTab`, and `longSession`.

`runtime.preference` accepts `auto`, `kitesurf`, or `chromium`. A preference does not override required capabilities. With a non-auto preference, disabling fallback makes that runtime choice strict.

The optional `targetUrl` must use HTTP(S) and pass the target policy. It is allocation/routing context and does not automatically navigate the new browser.

Read or terminate a tenant-owned session:

```bash
curl --fail-with-body "http://127.0.0.1:8080/v1/sessions/$SURFGATE_SESSION_ID" \
  -H "Authorization: Bearer $SURFGATE_API_KEY"

curl --fail-with-body -X DELETE \
  "http://127.0.0.1:8080/v1/sessions/$SURFGATE_SESSION_ID" \
  -H "Authorization: Bearer $SURFGATE_API_KEY"
```

Deletion is idempotent. Public responses never include the protected provider-session reference or upstream CDP URL.

## CDP relay

Only an active, unexpired session can issue a relay token:

```bash
curl --fail-with-body -X POST \
  "http://127.0.0.1:8080/v1/sessions/$SURFGATE_SESSION_ID/relay-token" \
  -H "Authorization: Bearer $SURFGATE_API_KEY"
```

The response contains `webSocketUrl`, a short-lived SurfGate `token`, and `expiresAt`. Connect with the token in an `Authorization: Bearer` WebSocket upgrade header. Tokens are not query-string credentials, are bound to one tenant/session, and stop authorizing when termination begins. The v1 relay allows one active controller per session.

See [`examples/playwright-cdp`](../examples/playwright-cdp/) for a Playwright Core client. Raw CDP exposes powerful browser navigation; read the [Security Model](SECURITY_MODEL.md) before enabling it for untrusted principals.

## Managed tasks

Tasks run against the existing active session. SurfGate never creates a replacement runtime for an unsupported task.

### Extract

```bash
curl --fail-with-body \
  "http://127.0.0.1:8080/v1/sessions/$SURFGATE_SESSION_ID/tasks" \
  -H "Authorization: Bearer $SURFGATE_API_KEY" \
  -H 'Idempotency-Key: extract-1' \
  -H 'Content-Type: application/json' \
  --data '{"type":"extract","selector":"main"}'
```

Successful extraction places bounded `title` and `text` fields in the task result.

### Screenshot

```json
{ "type": "screenshot", "format": "png", "fullPage": true }
```

For JPEG, `quality` may be an integer from 1 through 100. It is invalid for PNG.

### PDF

```json
{ "type": "pdf", "landscape": false, "printBackground": true }
```

Optional `widthInches` is 1–17 and `heightInches` is 1–22. The session runtime must support PDF. A capability declared experimental requires task-level `allowExperimental: true`.

Task creation returns HTTP 202. Poll status with:

```bash
curl --fail-with-body "http://127.0.0.1:8080/v1/tasks/$SURFGATE_TASK_ID" \
  -H "Authorization: Bearer $SURFGATE_API_KEY"
```

Statuses are `queued`, `running`, `retry_pending`, `succeeded`, `failed`, or `cancelled`. Delivery is at least once: bounded read-only work may repeat after a lost lease or uncertain persistence result. SurfGate does not promise exactly-once browser execution.

Screenshot/PDF results contain artifact metadata. Download bytes through SurfGate:

```bash
curl --fail-with-body "http://127.0.0.1:8080/v1/artifacts/$SURFGATE_ARTIFACT_ID" \
  -H "Authorization: Bearer $SURFGATE_API_KEY" \
  --output artifact.bin
```

Artifacts remain private and tenant-scoped. The API does not return large base64 bodies or signed object-store URLs.
