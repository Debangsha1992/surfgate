# ADR 0003 — Deterministic routing before learned routing

Status: Accepted.

## Decision

MVP routing uses hard capability filters plus versioned deterministic scoring.

No LLM or online ML is required in the routing critical path.

## Rationale

- explainability,
- reproducibility,
- operational debugging,
- security,
- easier tests.

Learned compatibility signals may later influence a bounded score through a new ADR.
