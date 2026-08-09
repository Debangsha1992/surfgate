# ADR 0009: SQL-first PostgreSQL control-plane persistence

## Status

Accepted — 2026-08-08

## Context

Epic 5 requires durable tenant, API-key, session, and routing-decision data, explicit
migrations, transactions, tenant isolation, and compare-and-set session updates. The
repository had selected PostgreSQL as the durable store but had no ORM, query library,
migration runner, or established database package. The router must remain pure domain
logic and public contracts must remain free of database types.

## Decision

Use the `pg` PostgreSQL client behind an `apps/api` data-access boundary and committed,
ordered SQL migrations.

- `apps/api/migrations` is the only schema source.
- The migration command runs separately from API startup, uses one transaction plus a
  PostgreSQL advisory lock, and records SHA-256 checksums in `surfgate_migrations`.
- Runtime repositories contain parameterized SQL and validate every returned row with
  existing Zod/domain schemas.
- Session state changes use `version` compare-and-set updates scoped by both tenant and
  session ID. No process-local lock is authoritative.
- Session and routing-decision reads expose only tenant-scoped methods. The sole
  non-tenant lookup is the globally unique, non-secret API-key prefix used to establish
  the tenant context.
- Complete `RoutingDecision` JSON is stored after `RoutingDecisionSchema` validation,
  alongside indexed correlation/version columns. Routing semantics are not duplicated
  in SQL.

No ORM or second query abstraction is introduced. A later change may select one only
through a new ADR and migration/interoperability plan.

## Security decision

API keys contain 32 random secret bytes and are stored only as a public lookup prefix
plus a versioned, salted scrypt hash. Unknown prefixes still execute a dummy scrypt path.
Externally visible invalid/revoked/expired failures use canonical authentication errors.

Internal provider sessions are serialized only after provider-core validation and
encrypted with AES-256-GCM. The envelope uses a random 96-bit nonce, a 128-bit tag, a key
identifier, and tenant/session IDs as associated data. Production provides the 32-byte
key through validated configuration. Source code contains no key. Production deployments
must source and rotate this key through a secret manager/KMS; a future rotation change
must support a bounded read key ring while writing only with the current key.

## Consequences

Positive:

- predictable SQL and transaction behavior;
- explicit, reviewable, forward-safe migrations;
- no database leakage into router/contracts;
- tenant-scoped access is visible in repository APIs and SQL;
- session races are resolved by PostgreSQL rather than process affinity.

Costs:

- row mapping and SQL remain explicit application code;
- operators must run migrations before deployment;
- production key rotation needs a later key-ring/KMS integration before changing the
  active provider-session encryption key.
