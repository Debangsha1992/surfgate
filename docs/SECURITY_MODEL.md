# Security Model

SurfGate assumes API clients and browser targets may be untrusted. Its controls reduce risk but do not turn unrestricted browser control into a complete network sandbox.

> **Raw-CDP limitation:** SurfGate does **not** currently claim complete SSRF or network isolation for arbitrary raw CDP browser activity. A trusted CDP principal can issue navigation and network commands after session creation. Untrusted raw-CDP deployments require independent network-egress controls or provider/browser request interception.

Production configuration disables raw CDP by default. Enabling trusted mode is an explicit trust decision, not a bypass-proof containment claim.

## Identity and tenant isolation

- API keys contain a safe lookup prefix and random secret. Only scrypt-hashed metadata is stored; plaintext is shown once.
- Authentication establishes tenant, key ID, and scopes. Repository operations for sessions, routing decisions, tasks, artifacts, idempotency, and audit data are tenant-scoped.
- Cross-tenant misses use tenant-safe not-found behavior rather than revealing another tenant's resource.
- Idempotency and quota coordination include tenant scope.

## Relay and provider credentials

Relay tokens are short-lived signed SurfGate credentials bound to one tenant, one session, and the relay audience. A valid signature is insufficient: the relay also checks current session state, expiry, revocation, and distributed connection ownership.

Cloudflare tokens and secret-bearing upstream CDP URLs remain server-side. Provider-session references are encrypted at rest and are never public API fields. New privileged relay connections fail closed when authorization dependencies are unavailable.

## Target policy

Control-plane target URLs allow HTTP(S) only, reject embedded credentials, normalize hostnames, resolve and inspect all returned IP addresses, and reject private, loopback, link-local, metadata, multicast, unspecified, and other special-use destinations by default. DNS lookup time and answer count are bounded.

`targetUrl` does not itself navigate the allocated browser, so SurfGate does not follow redirects at allocation time. These checks protect targets SurfGate itself validates, but cannot pin or revalidate every later `Page.navigate`, script-driven navigation, popup, redirect, provider-side DNS resolution, or subresource request made through a transparently controlled remote browser. Those flows are part of the raw-CDP limitation above.

## Data handling

- Central redaction removes authorization, cookies, API/relay/provider tokens, signing/encryption material, passwords, protected references, and secret query values from structured logs and errors.
- Raw CDP frames, DOM/page contents, extracted text, screenshots, PDFs, and signed URLs are not logged.
- Metric attributes use bounded categories, never tenant/session/task/artifact/request IDs or arbitrary URLs.
- Screenshot and PDF bytes live in private S3-compatible object storage. PostgreSQL stores tenant-scoped metadata and integrity hashes.

## Resource controls

HTTP bodies, relay frames and queues, active sessions, task queues/attempts, output sizes, provider operations, DNS lookups, connection lifetimes, and shutdown drains are bounded. Allocation permits at most one classified cross-runtime fallback. Task retries are bounded and at-least-once, not exactly-once.

## Deployment responsibilities

Operators must isolate database, Redis, and object storage; enforce private bucket policy and lifecycle cleanup; rotate keys with the documented overlap procedure; restrict outbound browser networks when principals are untrusted; and keep dependencies patched. See [operations](../operations/) for deployment and incident procedures.
