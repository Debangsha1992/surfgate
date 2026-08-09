# ADR 0005 — SurfGate-controlled CDP relay

Status: Accepted for product direction.

## Decision

Clients connect to a SurfGate WebSocket relay rather than receiving provider credentials.

## Rationale

Needed for:
- credential isolation,
- session authorization,
- revocation,
- quotas,
- telemetry,
- provider independence.

## Constraint

Do not parse/persist full CDP payload unless a defined feature requires it.
