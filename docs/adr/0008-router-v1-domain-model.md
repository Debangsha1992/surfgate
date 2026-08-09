# ADR 0008: Router v1 Pure Domain Model

## Status

Accepted — 2026-08-08

## Context

SurfGate must select a provider/runtime candidate deterministically before the
control plane allocates it. Epic 4 also calls for a persistence-ready decision
and bounded fallback, but the repository has not established an application
database layer or selected an ORM. Adding storage or provider calls to the
router would couple domain policy to infrastructure and make replay unreliable.

## Decision

Implement `packages/router` as synchronous pure domain logic depending only on
`packages/contracts`, `packages/provider-core`, and Zod.

`RoutingInput` contains explicit decision/request/tenant IDs, evaluation time,
capability registry version, capability requirements, runtime selection,
maximum duration, tenant policy, provider-neutral descriptor/health sources,
and optional normalized compatibility/efficiency/latency signals. Optional
signals use documented deterministic defaults.

`router-v1` first applies all hard capability, experimental-policy,
configured/health/capacity, tenant policy, duration, strict-runtime, and product
safety filters. Only eligible candidates receive the immutable weighted score:

```text
preference    30
efficiency    25
compatibility 20
health        15
latency        5
capacity       5
```

Tie-breaking is total score, preference score, efficiency score, then binary
lexicographic candidate ID. Candidate construction is also canonically sorted.
No time, randomness, process order, provider call, or database lookup occurs
inside selection.

The strict `RoutingDecisionSchema` is serializable persistence-ready domain
data. It includes versions, identity/correlation fields, selected and rejected
candidate explanations, score breakdowns, normalized health snapshots, and the
effective fallback policy. Physical PostgreSQL persistence and any repository
implementation belong to the Epic 5 control-plane/database milestone.

Fallback is a separate pure classifier and state reducer. It models the
allocation lifecycle and allows a maximum of one safe cross-runtime fallback.
It does not allocate providers or replay browser actions. Authentication,
policy, security, quota, malformed/invalid, cancellation, termination, and
unknown failures fail closed without fallback. Every attempt carries one
canonical candidate identity, so its candidate ID and runtime cannot disagree
and the reducer proves that a fallback crosses runtimes. Its terminal state
retains the original failure, ordered choices, and final outcome, and persisted
fallback history must remain within the effective fallback policy.

## Consequences

- Identical validated input produces an identical decision.
- Hard constraints cannot be rescued by weights or preferences.
- Every candidate has stable machine-readable selection or rejection reasons.
- Future API, persistence, and telemetry layers can consume one validated
  decision without making the router infrastructure-aware.
- Changing weights, defaults, tie-breaking, strict preference semantics, or
  fallback eligibility requires a new policy version and deliberate ADR update.
