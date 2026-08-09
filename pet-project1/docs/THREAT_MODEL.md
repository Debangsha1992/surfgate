# SurfGate Threat Model

Method: lightweight STRIDE-oriented model.

## Assets

- provider API credentials,
- SurfGate API keys,
- relay signing keys,
- active browser sessions,
- target-site authenticated state,
- tenant metadata,
- browser artifacts,
- audit records,
- routing policies.

## Trust boundaries

TB1: external client → SurfGate API  
TB2: external client → SurfGate relay  
TB3: SurfGate → Postgres/Redis/object storage  
TB4: SurfGate → browser provider  
TB5: browser runtime → target website  
TB6: CI/contributor code → protected credentials

---

## Threats

### T1 Cross-tenant session access

Attack:
Tenant A guesses session ID owned by B.

Controls:
- opaque IDs,
- tenant-scoped authorization,
- token contains tenant/session,
- integration tests,
- audit denied access.

### T2 Provider credential disclosure

Attack:
Credential returned in session metadata or logged from upstream URL/header.

Controls:
- server-side provider references,
- redaction,
- response schema allowlists,
- tests scanning serialized responses/log fixtures.

### T3 SSRF to metadata/internal services

Attack:
Target URL resolves/redirects/rebinds to internal IP.

Controls:
- scheme allowlist,
- DNS/IP validation,
- redirect validation,
- private-range block,
- controlled egress architecture later.

### T4 Relay token replay

Controls:
- short expiry,
- session scope,
- jti,
- optional one-time exchange,
- revocation/session state check.

### T5 WebSocket memory exhaustion

Controls:
- frame limits,
- buffer limits,
- backpressure,
- concurrency quotas,
- connection duration.

### T6 Provider retry storm

Controls:
- circuit breaker,
- bounded fallback,
- exponential backoff for background probes,
- no recursive retries.

### T7 Duplicate side-effect from fallback

Attack/failure:
Task action succeeds but response is lost, then task replayed on fallback.

Controls:
- session allocation fallback separate from action replay,
- classify task mutability,
- no automatic replay of unsafe actions.

### T8 Prompt injection in website

SurfGate itself should not interpret target content as trusted control instructions.

If future policy/agent layers inspect content:
- website content is untrusted data,
- browser content cannot authorize privileged SurfGate operations.

### T9 Malicious upstream provider error

Attack:
Provider returns secret-like or HTML payload that is reflected to user/logs.

Controls:
- normalized errors,
- bounded sanitized message,
- private diagnostic code,
- no raw reflection.

### T10 Dependency compromise

Controls:
- lockfile,
- dependency review,
- scanning,
- minimal dependencies,
- protected releases.

### T11 CI credential theft from untrusted PR

Controls:
- no protected secrets in fork PR jobs,
- live provider tests only trusted workflow,
- environment approvals.

### T12 Stale session leak

Failure:
Relay disconnects but upstream survives.

Controls:
- termination hooks,
- TTL,
- reconciliation worker,
- provider-side keep-alive bounded,
- leak metric.

---

## Highest-priority security tests

1. Cross-tenant session/relay/artifact access.
2. Cloud metadata and RFC1918 SSRF.
3. Redirect to private network.
4. DNS rebinding simulation.
5. Expired/replayed relay token.
6. Oversized WebSocket frame.
7. Upstream credential redaction.
8. Terminal session cannot reconnect.
9. Quota race under concurrent requests.
10. Session leak cleanup after relay crash.
