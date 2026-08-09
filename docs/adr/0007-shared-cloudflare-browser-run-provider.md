# ADR 0007: Shared Cloudflare Browser Run Provider Layer

## Status

Accepted — 2026-08-08

## Context

SurfGate's Kitesurf and Chromium adapters are distinct runtimes with different
selection rules, capabilities, and compatibility claims, but both use
Cloudflare Browser Run's account-scoped transport and session lifecycle. Copying
that code would duplicate credential handling, fixed-host URL validation,
bounded response parsing, cancellation/timeouts, Cloudflare error mapping,
invalid-allocation cleanup, and concurrent idempotent termination.

Moving Cloudflare mechanics into `provider-core` or `contracts` would violate
provider neutrality. Making one concrete provider depend on the other would
also invert the intended adapter boundaries.

Current official Cloudflare documentation retains the
`/browser-rendering/devtools` namespace for stable Chromium. Kitesurf's verified
beta contract uses `/browser-run/devtools` plus `browser=kitesurf` and may return
a connection URL in either namespace. Those differences must stay explicit.

## Decision

Create private workspace package `@surfgate/provider-cloudflare`.

It owns only proven shared Cloudflare behavior:

- validated `api.cloudflare.com/client/v4` construction;
- server-side bearer authentication from validated config;
- composed `AbortSignal` and finite operation timeout;
- bounded success/error body consumption;
- normalized authorization, rate/capacity, transient, connection, timeout,
  cancellation, invalid-response, termination, and unknown failures;
- validated allocation plus one bounded best-effort cleanup;
- normalized health probing;
- idempotent, bounded, concurrent termination semantics.

Each concrete provider supplies an immutable internal profile containing its API
namespace, optional browser selector, accepted clean connection namespaces,
descriptor, capability map, keep-alive bound, and any absolute duration bound.
`provider-kitesurf` and `provider-chromium` remain thin independent adapters and
do not import one another.

`provider-core` and `contracts` remain Cloudflare-independent. Cloudflare
credentials, headers, raw bodies, and secret-bearing connection data never enter
public contracts or provider descriptors.

## Consequences

- Security-sensitive Cloudflare lifecycle code has one implementation and is
  exercised by both exact provider conformance suites.
- Kitesurf retains explicit `browser=kitesurf`, its beta capability posture, and
  its namespace compatibility allowance.
- Chromium uses stable `/browser-rendering/devtools` with no Kitesurf selector,
  a separate capability declaration, and the same lifecycle guarantees.
- A Cloudflare transport change must pass both provider suites and both gated
  live lifecycle probes before release.
- The shared package is intentionally private and is not a general provider or
  routing abstraction.
