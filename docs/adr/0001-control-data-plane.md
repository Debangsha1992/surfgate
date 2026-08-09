# ADR 0001 — Separate control plane and relay data plane

Status: Accepted for initial architecture.

## Context

REST API requests are short-lived. CDP WebSocket connections are long-lived and have different scaling/backpressure characteristics.

## Decision

Model API/control plane and relay data plane as separate deployable applications, even if early development runs them together.

## Consequences

Positive:
- independent scaling,
- fault isolation,
- clearer security boundary.

Cost:
- internal session lookup/token design,
- more deployment components.
