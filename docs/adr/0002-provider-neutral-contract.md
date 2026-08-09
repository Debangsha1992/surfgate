# ADR 0002 — Provider-neutral public contract

Status: Accepted.

## Decision

No Cloudflare/Kitesurf/Chromium SDK types in public SurfGate API contracts.

Public requests express capabilities and preferences.

Provider details are adapters.

## Rationale

Kitesurf is beta and capability coverage will evolve. SurfGate must remain useful across runtime changes/providers.
