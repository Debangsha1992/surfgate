# SurfGate Security Architecture

## 1. Security posture

SurfGate controls privileged browser sessions. It must assume:

- clients can be malicious,
- target websites can be malicious,
- browser content can contain prompt injection,
- provider errors can contain sensitive strings,
- WebSocket clients can send malformed or oversized messages,
- tenants must be isolated from one another.

---

## 2. Non-negotiable invariants

1. Provider credentials never reach clients.
2. Tenant A cannot access Tenant B resources.
3. Browser targets cannot access private/internal networks by default.
4. Redirects are revalidated.
5. Relay credentials are short-lived and session-scoped.
6. Raw browser/CDP traffic is not logged by default.
7. Secrets are redacted centrally.
8. Authz occurs server-side for every resource access.
9. Security policy denial does not trigger fallback around the policy.
10. Production secrets are stored outside source control.

---

## 3. Authentication

MVP API key format can use:

```text
sg_live_<public-prefix><secret>
sg_test_<public-prefix><secret>
```

Storage:
- prefix/index metadata,
- Argon2id or strong keyed hash strategy for secret,
- never plaintext.

The implemented control-plane format uses a 12-hex-character public prefix, 32 random
secret bytes, and a versioned salted scrypt hash. Comparison uses constant-time byte
comparison, and an unknown valid prefix still consumes a dummy scrypt verification path.
The complete key is returned only once. Logs, public metadata, and errors contain neither
the secret nor the stored hash.

Consider HMAC-based API key verification for high request volume.

Key properties:
- tenant,
- scopes,
- createdAt,
- expiresAt,
- revokedAt.

---

## 4. Relay token

Relay tokens must be:
- signed,
- short-lived,
- specific to `sessionId`,
- specific to `tenantId`,
- audience `surfgate-relay`,
- include `exp`,
- include unique `jti`,
- revocable or checked against session terminal state.

Do not place upstream credentials inside token claims.

PASETO or carefully implemented JWT are acceptable subject to ADR.

---

## 5. SSRF prevention

Because the product intentionally browses URLs, SSRF protection requires explicit policy.

Default:
- public HTTP/HTTPS only.

Block:
- localhost,
- loopback IPv4/IPv6,
- RFC1918,
- link-local,
- metadata IP ranges,
- unique-local IPv6,
- internal DNS names,
- non-HTTP protocols.

Algorithm:
1. parse/canonicalize URL,
2. validate scheme,
3. resolve DNS,
4. reject forbidden IPs,
5. connect with DNS pinning/resolution control when feasible,
6. repeat for each redirect,
7. limit redirects.

Mitigate DNS rebinding:
- resolve immediately before use,
- validate every resolved address,
- avoid trusting hostname validation performed minutes before connection,
- consider a controlled egress proxy for stronger enforcement.

The Epic 5 control plane implements the parse/scheme/credential/hostname/all-address DNS
checks with a bounded resolver before passing a target to a provider. Provider-side navigation,
DNS pinning, and redirect-by-redirect revalidation remain mandatory Epic 7/relay egress work;
the control plane does not claim those later controls are already complete.

---

## 6. Target-site protections

SurfGate is not an anti-bot bypass product.

Do not implement:
- CAPTCHA bypass,
- stealth patches,
- fingerprint spoofing intended to evade access controls,
- proxy rotation intended to defeat protections,
- credential/session theft.

A provider/runtime can be selected for legitimate compatibility, but SurfGate must not advertise circumvention.

---

## 7. WebSocket controls

- authenticated upgrade,
- session ownership check,
- max frame size,
- max connection duration,
- idle timeout,
- upstream connect timeout,
- bounded send/receive buffer,
- backpressure,
- connection rate limit,
- per-tenant concurrent-session limit,
- graceful close,
- abnormal-close metrics.

Fuzz relay framing/parsing.

---

## 8. Artifact security

- private buckets,
- random opaque object keys,
- tenant prefix,
- encryption at rest,
- TLS in transit,
- signed URLs,
- short expiry,
- media type validation,
- max object size,
- retention/deletion jobs.

Do not execute uploaded artifacts.

---

## 9. Logging and redaction

Never log:
- Authorization header,
- API key secret,
- provider API token,
- upstream CDP URL if it embeds secret material,
- Cookie header,
- Set-Cookie value,
- raw local/session storage,
- arbitrary page DOM,
- passwords/form fields.

URL logging:
- prefer origin/hostname,
- strip query and fragment by default,
- treat path as potentially sensitive.

Central logger must recursively redact known key names.

---

## 10. Database

- TLS connections in production,
- least-privilege DB roles,
- migration role separate from runtime role where practical,
- encrypted provider session reference if it contains sensitive data,
- row access always tenant scoped.

`apps/api` repositories require tenant ID plus resource ID for sessions and routing
decisions, and PostgreSQL foreign keys preserve tenant ownership. Session transitions use
version compare-and-set updates. Internal provider sessions are runtime validated and
stored only as AES-256-GCM ciphertext with tenant/session associated data. Production
must source the key from a secret manager and follow ADR 0009 for rotation; no fallback or
hard-coded encryption key is permitted.

Consider PostgreSQL RLS as defense in depth, not a substitute for application authz.

---

## 11. Secrets

Production:
- secret manager,
- rotation,
- separate per environment,
- no shared developer credential.

Cloudflare token:
- minimal Browser Run/Rendering permission required,
- separate test/prod accounts or tokens,
- rotate on suspected exposure.

---

## 12. Supply-chain security

CI:
- dependency lockfile,
- dependency vulnerability scan,
- secret scan,
- SAST,
- artifact provenance/SBOM later,
- protected main branch.

Avoid automatic execution of untrusted PR code with production provider secrets.

Live provider tests from external contributions need protected workflow boundaries.

---

## 13. Abuse prevention

Controls:
- tenant quotas,
- URL policy,
- concurrency limits,
- task timeout,
- object size limits,
- audit,
- account suspension.

Do not enable arbitrary network tunneling through the CDP relay.

---

## 14. Incident response hooks

Security events:
- repeated cross-tenant access attempts,
- SSRF attempts,
- invalid/replayed relay tokens,
- unusual session concurrency,
- provider credential auth failures,
- excessive blocked targets.

Emit security-specific audit/metrics without sensitive payloads.

---

## 15. Security release gate

Before public production:
- threat model reviewed,
- SSRF test suite passing,
- cross-tenant integration tests passing,
- API key/relay token tests passing,
- log-redaction tests passing,
- dependency and secret scan clean,
- load test includes malicious/oversized WebSocket frames,
- provider credentials proven absent from API responses/logs.
