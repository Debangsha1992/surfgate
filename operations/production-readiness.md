# Production readiness

## Assessment

**CONDITIONAL GO** for a deployment that either leaves raw CDP disabled (the production default) or restricts raw CDP to explicitly trusted principals and enforces an independent provider/deployment egress boundary. Managed tasks remain available when raw CDP is disabled.

The raw-CDP boundary is **MITIGATED WITH EXPLICIT TRUST BOUNDARY**, not resolved. SurfGate cannot prove that every navigation, popup, subresource, redirect, or provider-side DNS result initiated through transparent CDP remains outside private networks. `SURFGATE_RAW_CDP_ACCESS=trusted` is therefore an explicit deployment decision, never a production default.

No known P0 production blocker remains for that deployment model. A release remains blocked until the deterministic release gate, integration suite, capacity smoke, migration check, and a restore from the production backup/PITR mechanism have passed in the release environment. The repository's test-database dump/restore command is a tooling/schema smoke only; it cannot substitute for production-backup restore evidence.

## Component readiness

| Component | Release evidence                                                                             | Production prerequisite                                                               |
| --------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| API       | Auth, tenant isolation, idempotency, quotas, routing, schema-aware readiness, graceful close | PostgreSQL, Redis, Cloudflare credentials, current migrations, TLS termination        |
| Relay     | Authenticated bounded proxy, distributed ownership/revocation, drain tests                   | PostgreSQL, Redis, signing/encryption keys, WSS public origin; raw-CDP trust decision |
| Worker    | Bounded claims, leases, retries, artifact limits, graceful drain                             | PostgreSQL, private object storage, Cloudflare credentials                            |
| Providers | Shared conformance suites and bounded operations                                             | Correct Browser Run token permission and account capacity                             |
| Data      | Append-only migrations, immutable audit events, encrypted provider references                | Automated encrypted backups/PITR and tested restore                                   |

Liveness means the process/event loop can answer. Readiness means the component can safely accept new work and validates the current schema migration. Provider degradation does not make API liveness fail. PostgreSQL, security-critical Redis, or worker object-storage failure removes the affected service from readiness. Telemetry export failure is bounded and does not remove serving readiness.

## Production configuration classes

- **Required:** `NODE_ENV=production`, TLS PostgreSQL and Redis URLs, S3 region/bucket, secure WSS relay origin, Cloudflare account/token, independent relay-signing and provider-reference-encryption keys, and current database schema.
- **Secrets:** database/Redis credentials, object-store credentials, Cloudflare token, signing keys, and encryption keys. Inject them at runtime from the selected secret manager; never bake them into images.
- **Development-only:** loopback dependency URLs, plaintext Redis, WS relay URLs, repeated/example cryptographic keys, `.env`, and local Docker credentials.
- **Operational tuning:** pool, provider, relay, worker, reconciliation, telemetry, and shutdown timeouts.
- **Safety limits:** quotas, maximum session/task durations, task attempts, artifact/frame/queue sizes, relay duration, telemetry queue/cardinality, and reconciliation batch size.

Production parsing rejects missing core credentials, insecure transports, loopback dependency endpoints, missing current key IDs, obvious development key material, and cross-purpose cryptographic key reuse. Migration, reconciliation, relay, and worker entrypoints load component-scoped configuration so they do not receive unrelated high-value credentials. The example environment intentionally leaves production trust and secrets unset.

## Key rotation

Encryption and signing keys have independent identifiers and material.

1. Generate a new key and unique ID in the secret manager without changing the current writer key.
2. **Preload phase:** deploy every API, relay, worker, and reconciliation process with the old key still current and the new key in the matching `*_PREVIOUS_KEY{,_ID}` read/verify slot. Verify the entire fleet accepts the new key ID before proceeding.
3. **Switch phase:** deploy the fleet with the new key current and the old key in the previous slot. During this rollout, old preloaded nodes emit the old key but accept the new one, while new nodes emit the new key and accept the old one. Do not switch writers before preload is complete.
4. For relay signing, retain the old key longer than the maximum issued token TTL (five minutes) plus rollout clock skew.
5. For provider-reference encryption, retain the old key until every session protected by it is terminal and cleaned up. Key IDs identify remaining envelopes without revealing plaintext.
6. Verify new issuance, both key IDs' verification/decryption, readiness, and termination/reconciliation before removing the old key.

Emergency revocation may intentionally invalidate old relay tokens immediately. Emergency removal of a provider-reference key can strand live sessions and requires provider-side cleanup; it is an incident action, not ordinary rotation.

## Release gates

Run from a fresh checkout with Node 24 and pnpm 10.15.1:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm release:check
pnpm test:capacity
pnpm test:recovery
```

Integration gates require isolated PostgreSQL (`*_test`) and Redis. Live Cloudflare/object-storage smoke remains separately credential-gated and must always clean up. `skills-lock.json`, `.env`, Codex state, build output, and local caches are not release inputs.

## Known limitations and lower-priority work

- Raw CDP is not general-tenant SSRF containment. Keep it disabled or trusted-only with independent egress isolation.
- A process crash in the narrow interval after a provider creates a session but before SurfGate receives/protects the reference cannot be deterministically correlated when the provider offers no idempotent allocation key. Reconciliation marks the allocation outcome uncertain and surfaces suspected leak counts; provider TTL and provider-side inventory are the final bound.
- Managed browser execution is at least once. SurfGate does not claim exactly-once browser side effects.
- Artifacts are private, time-bounded results rather than the durable system of record. Unknown object-upload/database-commit outcomes require lifecycle rules and inventory reconciliation.
- Capacity smoke establishes regression evidence, not a customer SLA or universal fleet-size claim.

## Release decision checklist

- [ ] `pnpm release:check` passes on the candidate SHA.
- [ ] `pnpm test:capacity` and `pnpm test:recovery` pass with no leaked ownership.
- [ ] Empty/previous-schema migration test and production migration job pass.
- [ ] Local test-database restore smoke succeeds; separately restore an actual production backup/PITR artifact in an isolated release environment and retain that evidence.
- [ ] Images build for API, relay, and worker and run as non-root.
- [ ] Production secrets, current/previous key IDs, TLS, public origins, and raw-CDP mode are reviewed.
- [ ] Network policy exposes only API/relay and protects data/internal health endpoints.
- [ ] Dashboards, alerts, backups, artifact lifecycle, and on-call ownership exist.
- [ ] Live smoke succeeds when release credentials are available.
