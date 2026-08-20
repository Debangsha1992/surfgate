# Deterministic Routing

SurfGate routes a provider-neutral session request to one eligible runtime candidate. Identical routing inputs and policy snapshots produce the same selection, score breakdown, and reason codes (apart from explicitly time-based metadata).

## Decision stages

1. Build candidates from provider descriptors, configuration, health, and optional signals.
2. Apply hard capability and safety constraints.
3. Apply tenant provider/runtime policy and duration limits.
4. Reject unavailable or unconfigured candidates; penalize allowed degraded candidates.
5. Score eligible candidates with the versioned `router-v1` policy.
6. Break ties by explicit preference, efficiency, then canonical candidate ID.
7. Return the selected candidate plus eligible/rejected explanations.

Required capabilities are never rescued by a high score. Experimental support qualifies only when `allowExperimental` is true; unsupported or unknown required support is rejected. Preferred capabilities can influence score but do not alone make a candidate ineligible.

## Runtime roles

Kitesurf is the lightweight fast path when its declared capabilities and current health satisfy the request. Chromium is the broader compatibility path. These are tendencies produced by general eligibility and scoring—not a hard-coded provider shortcut.

For example, JavaScript and DOM requirements may allow Kitesurf when experimental capabilities are permitted. A requirement that the Kitesurf descriptor does not support rejects Kitesurf, allowing Chromium only if Chromium declares compatible support and policy permits it. See [Providers](PROVIDERS.md) for where declarations live; callers should not assume capability coverage without inspecting the current descriptor.

## Reasons and fallback

Machine-readable reason codes explain capability satisfaction, policy denial, health, preference, score rank, and no-compatible-runtime outcomes. Allocation failures are classified separately from browser actions.

SurfGate permits at most one automatic cross-runtime fallback during session allocation, and only for an eligible classified failure. Authentication, validation, policy, quota, and security failures do not fall back. An active browser session never migrates or replays arbitrary actions on another runtime.
