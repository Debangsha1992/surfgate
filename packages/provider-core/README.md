# packages/provider-core

Browser provider interfaces and normalized provider error model.

`@surfgate/provider-core` is the provider-neutral internal boundary used by
future routers, services, and concrete browser adapters. It depends only on
`@surfgate/contracts` and Zod.

`BrowserProvider` exposes:

- synchronous, stable `descriptor()` data with exhaustive capability support;
- normalized `health()` snapshots that distinguish configured healthy,
  degraded, unavailable, and not-configured states;
- bounded, cancellation-aware `allocate()` returning a validated internal
  `ProviderSession`;
- bounded, cancellation-aware `terminate()` with `terminated` and
  `already_terminated` outcomes.

Every asynchronous operation requires a finite `timeoutMs` and accepts an
optional `AbortSignal`. Implementations must normalize failures into
`ProviderError`; canonical error messages and stable codes ensure raw upstream
values are not exposed.

`ProviderSession.connection` is internal SurfGate data, never a public API
response. It contains a websocket endpoint and an opaque credential reference,
not raw provider headers or tokens. The future relay/upstream resolver must
resolve that reference server-side. Connection endpoints cannot contain URL
userinfo, query strings, or fragments; credentials must never be embedded in a
URL.

Termination is idempotent from SurfGate's perspective. An already-gone or
unknown provider session normally returns `already_terminated`; it is not an
application-level failure.
