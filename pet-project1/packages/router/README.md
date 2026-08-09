# packages/router

Pure deterministic runtime eligibility, scoring, decision, and fallback logic.

`routeBrowserRuntime()` consumes only validated provider descriptors, normalized
health snapshots, tenant policy, capability requirements, and optional
normalized compatibility/efficiency/latency signals. It never instantiates a
provider, allocates a session, performs I/O, or persists data.

The `router-v1` sequence is:

1. build and lexically sort stable provider-neutral candidates;
2. reject hard capability, policy, health, capacity, duration, and safety
   failures;
3. score only eligible candidates with one immutable versioned policy;
4. choose by total score, preference, efficiency, then candidate ID;
5. return a strict, serializable `RoutingDecision` with candidate explanations,
   health snapshots, and effective fallback policy.

`preference=kitesurf|chromium` is a scoring preference while fallback is
allowed. When effective fallback is disabled, it becomes a strict runtime
constraint. Hard constraints are never score inputs.

The separate fallback reducer models `REQUESTED`, `ROUTED`, `ALLOCATING`,
`FALLBACK_ROUTED`, `FALLBACK_ALLOCATING`, `ACTIVE`, and `FAILED`. It permits at
most one safe cross-runtime allocation fallback and never replays browser
actions.

Run the focused and golden suites with:

```bash
pnpm --filter @surfgate/router test
pnpm --filter @surfgate/router test:golden
```
