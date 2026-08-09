# SurfGate Routing Specification

## 1. Goal

Select the cheapest/most efficient runtime that can safely satisfy a workload while preserving compatibility and providing explainable fallback.

The first release is deterministic.

---

## 2. Candidate identity

A candidate is:

```text
provider + runtime class + region/config profile
```

Examples:

```text
cloudflare-browser-run / kitesurf
cloudflare-browser-run / chromium
local-development / chromium
```

---

## 3. Inputs

The authoritative provider-neutral schemas live in `packages/contracts`.
Capability names are exactly:

```text
javascript
dom
xhr
svg
screenshot
pdf
webgl
video
persistentAuth
realBrowserTLS
downloads
uploads
multiTab
longSession
```

Provider support states are `supported`, `unsupported`, `experimental`, and
`unknown`. Request requirement states are `required`, `preferred`, and
`not_required`. Runtime preferences are `auto`, `kitesurf`, and `chromium`.
Provider support maps are exhaustive: every capability must declare one of the
four support states, using `unknown` rather than omitting an entry. Client
requirement maps may be partial; an omitted requirement has the same eligibility
effect as `not_required`.

```ts
type RoutingInput = {
  decisionID: RoutingDecisionID
  tenantID: TenantID
  requestID: RequestID
  createdAt: string
  capabilityRegistryVersion: string
  tenantPolicy: TenantRoutingPolicy
  requirements: CapabilityRequirements
  runtime: RuntimeSelection
  maxSessionDurationMs: number
  candidateSources: RoutingInputSource[]
  signals: {
    compatibility: CandidateScoreSignal[]
    efficiency: CandidateScoreSignal[]
    latency: CandidateScoreSignal[]
  }
}
```

---

## 4. Phase 1 — validation

Reject invalid combinations before provider work.

Examples:

- negative max duration,
- unknown required capability,
- tenant forbids all providers,
- unsupported target scheme.

---

## 5. Phase 2 — hard eligibility

For every candidate:

### Capability

Required capability:

- `supported` -> pass
- `experimental` -> pass only when request allows experimental
- `unsupported` -> reject
- `unknown` -> reject

Preferred capability:

- never rejects a candidate;
- influences the versioned compatibility score only.

Not-required capability:

- does not affect eligibility or scoring.

### Health

- `unavailable` -> reject
- `degraded` -> eligible with penalty if policy allows
- `healthy` -> pass

### Tenant policy

Examples:

- allowed providers
- forbidden providers
- maximum session duration
- runtime allowlist

Policy denial rejects candidate.

### Product safety

Examples:

- known runtime incompatibility for requested feature
- session duration beyond runtime contract

---

## 6. Initial Kitesurf capability policy

Must be treated as versioned, configurable, and validated by conformance tests.

The initial descriptor verified from Cloudflare's Kitesurf documentation updated
August 7, 2026 is:

```text
javascript       experimental
dom              experimental
xhr              experimental
svg              experimental
screenshot       experimental
pdf              experimental
webgl            unsupported
video            unsupported
persistentAuth   unsupported
realBrowserTLS   unsupported
downloads        unknown
uploads          unknown
multiTab         unsupported
longSession      unsupported
```

The first six capabilities have direct documentation through Kitesurf use cases,
Quick Actions, and current WPT coverage, but remain `experimental` while the
runtime is beta. Callers must explicitly opt in with `allowExperimental`; this
is not a claim of pixel-perfect Chromium parity, and site compatibility remains
empirical.
Downloads and uploads are `unknown` because the current Kitesurf documentation
does not make a reliable claim. Kitesurf explicitly trades away tabs and is
documented as unsuitable for WebGL, video, real-TLS challenge handshakes, and
long-running authenticated state.

Eligible documented workload classes include:

- DOM/HTML workflows
- JavaScript for compatible pages
- XHR/network inspection where supported
- screenshots on compatible sites
- HTML extraction
- short-lived agent/browser work

Route to Chromium when required:

- WebGL
- video
- real-browser TLS behavior needed for bot challenge handshake
- long persistent authenticated session

Do not encode these as forever-static product assumptions. The provider
descriptor version identifies the verified documentation snapshot, and later
Cloudflare behavior changes require descriptor, conformance, compatibility, and
routing-test updates together.

### 6.1 Initial Cloudflare Chromium capability policy

The Chromium descriptor verified from current Cloudflare Browser Run/CDP,
Playwright, session-reuse, and limits documentation on August 8, 2026 is:

```text
javascript       supported
dom              supported
xhr              supported
svg              supported
screenshot       supported
pdf              supported
webgl            supported
video            experimental
persistentAuth   supported
realBrowserTLS   supported
downloads        unknown
uploads          unknown
multiTab         supported
longSession      supported
```

WebGL and real-browser TLS follow Cloudflare's documented direction from
Kitesurf-incompatible workloads to full Chromium. `realBrowserTLS` means the
Chromium engine's TLS behavior only; Browser Run traffic remains bot-identified
and SurfGate does not use this capability to bypass site controls. Video is
`experimental` because Cloudflare directs video workloads to Chromium while
the current Playwright support page still says video is not fully supported.
Downloads and uploads remain `unknown` because the current Browser Run product
documentation does not establish them as supported session capabilities.

Persistent authentication reflects documented reusable sessions and storage
state. `longSession` reflects the absence of a fixed active-session maximum;
the ten-minute `keep_alive` value is only an inactivity window, and callers
must keep the session active within it. These values are descriptor evidence,
not routing policy, and must change with official documentation and provider
conformance evidence.

---

## 7. Phase 3 — score

Only eligible candidates are scored.

The implemented `router-v1` normalized dimensions are:

```text
preferenceScore        0..100
efficiencyScore        0..100
healthScore            0..100
compatibilityScore     0..100
latencyScore           0..100
capacityScore          0..100
```

Exact weighted score:

```text
0.30 * preference
0.25 * efficiency
0.20 * compatibility
0.15 * health
0.05 * latency
0.05 * capacity
```

All weights and defaults live in the immutable `ROUTER_V1_POLICY` structure.
Missing compatibility and latency signals score 50. Missing explicit efficiency
signals use the versioned runtime baseline: Kitesurf 100, Chromium 60, and an
unknown future runtime 50. Healthy health scores 100 and degraded health scores
50. Capacity scores are available 100, constrained 25, unknown 50; exhausted
capacity is rejected before scoring.

A preferred capability never rejects. When preferred capabilities exist, their
deterministic support score is averaged with the compatibility signal:
supported 100, permitted experimental 80, unpermitted experimental 40, unknown
25, and unsupported 0. This affects ranking only.

---

## 8. Default product preference

When capabilities are satisfied and providers healthy:

```text
Kitesurf > Chromium
```

because SurfGate's product hypothesis is to use Kitesurf as the efficient fast path.

This preference may be overridden by:

- tenant policy,
- compatibility evidence,
- provider health,
- explicit requirements,
- explicit runtime preference.

---

## 9. Tie-break

Tie-break MUST be stable.

Implemented hierarchy:

1. higher score,
2. higher preference score (caller preference first, then tenant preference),
3. higher versioned efficiency score,
4. lexicographically stable candidate ID.

Never use random selection in deterministic mode.

Candidate construction and tie-breaking use binary lexical comparisons, not object
insertion order or locale-dependent sorting. The evaluation timestamp and IDs
are explicit `RoutingInput` fields, so replaying identical input produces an
identical decision.

---

## 10. Decision record

Persist:

```json
{
  "decisionID": "rtd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "tenantID": "ten_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "requestID": "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "policyVersion": "router-v1",
  "capabilityRegistryVersion": "cap-v1",
  "createdAt": "2026-08-08T12:00:00.000Z",
  "outcome": "selected",
  "selectedCandidate": {
    "candidateID": "cloudflare-browser-run::kitesurf::-::=browser-run-kitesurf",
    "providerID": "cloudflare-browser-run",
    "runtimeClass": "kitesurf",
    "configProfile": "browser-run-kitesurf"
  },
  "eligibleCandidates": [
    {
      "candidate": {
        "candidateID": "cloudflare-browser-run::kitesurf::-::=browser-run-kitesurf",
        "providerID": "cloudflare-browser-run",
        "runtimeClass": "kitesurf",
        "configProfile": "browser-run-kitesurf"
      },
      "scoreBreakdown": {
        "preferenceScore": 50,
        "efficiencyScore": 100,
        "compatibilityScore": 50,
        "healthScore": 100,
        "latencyScore": 50,
        "capacityScore": 50,
        "totalScore": 70
      },
      "reasonCodes": [
        "CAPABILITIES_SATISFIED",
        "FAST_PATH_PREFERRED",
        "SELECTED_HIGHEST_SCORE"
      ],
      "selected": true
    }
  ],
  "rejectedCandidates": [],
  "reasonCodes": [
    "CAPABILITIES_SATISFIED",
    "FAST_PATH_PREFERRED",
    "SELECTED_HIGHEST_SCORE"
  ],
  "healthSnapshots": [
    {
      "candidateID": "cloudflare-browser-run::kitesurf::-::=browser-run-kitesurf",
      "health": {
        "status": "healthy",
        "configured": true,
        "diagnosticCode": "PROVIDER_HEALTHY",
        "capacity": "unknown",
        "checkedAt": "2026-08-08T12:00:00.000Z"
      }
    }
  ],
  "fallbackPolicy": {
    "allowed": true,
    "maximumCrossRuntimeFallbacks": 1
  }
}
```

Do not store secrets.

The implemented `RoutingDecisionSchema` additionally validates tenant, request,
and decision IDs; evaluation timestamp; outcome; selected marker consistency;
per-candidate score/rejection explanations; normalized health snapshots; and
the effective zero-or-one fallback policy. It is persistence-ready JSON domain
data. Physical PostgreSQL persistence is intentionally deferred to the Epic 5
control-plane/database layer; `packages/router` has no ORM, database, Redis, or
repository dependency.

---

## 11. Reason codes

Examples:

```text
CAPABILITIES_SATISFIED
FAST_PATH_PREFERRED
TENANT_RUNTIME_PREFERENCE
CANDIDATE_UNHEALTHY
CANDIDATE_DEGRADED
CANDIDATE_FORBIDDEN_BY_POLICY
REQUIRES_WEBGL
REQUIRES_VIDEO
REQUIRES_PERSISTENT_AUTH
REQUIRES_REAL_BROWSER_TLS
CAPABILITY_UNKNOWN
CAPABILITY_EXPERIMENTAL_NOT_ALLOWED
DOMAIN_COMPATIBILITY_LOW
PROVIDER_RATE_LIMITED
FALLBACK_FROM_RUNTIME
```

Reason codes are API/analytics contracts. Add deliberately.

The complete implemented registry also includes generic policy/runtime,
duration, safety, required-capability, selected/lower-score/tie-break,
no-compatible-runtime, and bounded-fallback reasons. Candidate records carry
the reasons needed to explain eligibility, rejection, selection, and
non-selection. Human-readable descriptions are registered separately from the
machine codes.

An explicit runtime preference remains a preference while effective fallback is
allowed. When either the request or tenant policy disables fallback, a non-auto
preference is treated as a strict runtime constraint. It still cannot override
capability, policy, health, duration, or safety requirements.

---

## 12. Error classification for fallback

### Retry/fallback eligible

Potential:

- provider allocation timeout,
- provider 5xx,
- provider capacity/rate limit,
- runtime incompatibility detected before any mutating action,
- upstream connection failure.

### Not eligible

- auth failed,
- invalid request,
- policy denied,
- private-network target blocked,
- tenant quota exhausted,
- unsupported mandatory capability with no other candidate.

### Special caution

A session allocation fallback is not the same as replaying an arbitrary browser action.

Do not automatically replay potentially mutating workflows.

---

## 13. Fallback budget

MVP:

```text
maximumCrossRuntimeFallbacks = 1
```

No loops.

Decision chain:

```text
Kitesurf -> Chromium -> stop
```

If Chromium fails, return a normalized terminal error.

The pure fallback reducer does not call either provider. Provider-core failures
are normalized into stable fallback classes. Transient upstream failure,
allocation timeout, rate/capacity pressure, connection failure, and pre-action
runtime incompatibility are eligible. Configuration/authentication, caller
cancellation, invalid/malformed input, policy/security denial, tenant quota,
invalid provider response, termination failure, no compatible candidate, and
unknown failure are not eligible. A second failure after fallback always enters
`FAILED` with `FALLBACK_LIMIT_REACHED`; no transition can return to the original
runtime. Each attempt records one canonical candidate identity containing its
provider, runtime, region, and profile, so a fallback must select a distinct
runtime rather than merely a different regional/profile candidate. Fallback and
terminal states retain the primary allocation failure, ordered attempts, and
final outcome for later audit records.

---

## 14. Health adaptation

Provider health should use:

- active probes,
- recent allocation outcomes,
- provider-reported rate limit state,
- circuit breaker.

Circuit breaker states:

- closed,
- open,
- half-open.

Do not let one tenant's invalid workload globally poison provider health.

Classify errors before feeding health statistics.

---

## 15. Compatibility learning

Not required for initial router, but design supports it.

Signals:

- domain,
- task class,
- runtime,
- failure class,
- success.

Avoid storing full URL/query data.

A low-confidence small sample should not override hard provider capability.

Potential Bayesian or rolling-rate scoring can be added later through an ADR.

---

## 16. Routing tests

Every rule requires:

- positive case,
- negative case,
- boundary case,
- reason-code assertions.

Golden test fixtures should cover:

- simple HTML -> Kitesurf,
- WebGL required -> Chromium,
- Kitesurf unavailable -> Chromium,
- Chromium forbidden + WebGL required -> no compatible runtime,
- explicit Kitesurf + no fallback + unsupported capability -> fail,
- deterministic tie,
- experimental capability,
- degraded provider,
- fallback once.

Router tests must not require live browser providers.
