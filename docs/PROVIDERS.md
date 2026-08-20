# Providers

SurfGate providers implement the provider-neutral lifecycle in `packages/provider-core`.

## Current adapters

- `provider-kitesurf` adapts the Kitesurf runtime.
- `provider-chromium` adapts the Chromium runtime.
- `provider-cloudflare` is the private shared Cloudflare Browser Run transport used by both adapters.

Cloudflare account credentials, upstream authorization headers, protected session references, and secret-bearing CDP URLs remain server-side.

## Contract responsibilities

A provider supplies:

1. A stable provider/runtime descriptor and explicit capability support levels.
2. Normalized health without conflating target incompatibility with infrastructure health.
3. Bounded allocation with `AbortSignal` support.
4. Idempotent/bounded termination behavior.
5. Secure internal connection metadata suitable for protected persistence and relay resolution.
6. Normalized error classifications safe for routing fallback and public error mapping.

## Adding a provider

Keep public contracts and the router provider-neutral. Implement the lifecycle interface in a dedicated package, validate external responses at runtime, centralize credentials in `packages/config`, and never place provider secrets in public schemas, errors, logs, or metric labels.

Register construction in the control-plane provider registry rather than adding runtime branches to HTTP handlers or routing logic. Declare capabilities conservatively: unknown is not supported for a required request.

Finally, run the shared provider conformance suite from `packages/testing` and add focused tests for transport normalization, aborts, allocation cleanup, and termination. A provider is not complete until conformance passes.
