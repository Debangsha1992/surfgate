# ADR 0006: Kitesurf Browser Run Lifecycle

## Status

Accepted — 2026-08-08

## Context

Cloudflare's Kitesurf documentation updated 2026-08-07 selects Kitesurf through
the current Browser Run CDP endpoint:

```text
wss://api.cloudflare.com/client/v4/accounts/{account}/browser-run/devtools/browser?browser=kitesurf
```

Cloudflare's generic HTTP session-management and generated API-reference pages
still show older `/browser-rendering/devtools` paths without a Kitesurf selector.
A live, immediately cleaned-up contract probe confirmed that the analogous
current HTTP lifecycle works:

```text
POST   /browser-run/devtools/browser?browser=kitesurf
DELETE /browser-run/devtools/browser/{sessionId}
```

The POST response is `{ sessionId, webSocketDebuggerUrl }`. At the time of the
probe, its clean WSS URL used the legacy `/browser-rendering` namespace even
though creation used `/browser-run`.

## Decision

The Kitesurf adapter sends health, allocation, and termination control calls to
the current `/browser-run/devtools` namespace and selects Kitesurf explicitly
with `browser=kitesurf`.

The returned WSS URL is accepted only when all of these hold:

- scheme is `wss`;
- hostname is exactly `api.cloudflare.com`;
- path is beneath the configured account ID;
- path ends in the exact returned session ID;
- namespace is exactly `/browser-run` or `/browser-rendering`;
- userinfo, query, and fragment are absent.

The compatibility allowance remains private to `provider-kitesurf`. It does not
weaken provider-core's clean internal connection URL contract or expose either
namespace publicly.

Termination uses one bounded DELETE with caller cancellation. Accepted close
responses are `closing` and `closed`; a bounded, expiring cache preserves
sequential idempotency, concurrent calls are single-flight, and upstream `404`
returns `already_terminated`. When allocation yields a valid session ID but
unsafe connection metadata, the adapter uses only the allocation's remaining
monotonic timeout and caller signal for one best-effort DELETE. Joined
termination callers retain independent cancellation/timeout budgets; a
surviving joiner takes over one close attempt if its leader aborts or times out.
The adapter performs no general automatic retries.

HTTP `429` is rate limiting unless the bounded, discarded error envelope exactly
matches Cloudflare's documented `Browser time limit exceeded for today` quota
condition, which is normalized as exhausted capacity. Cloudflare `5xx` remains
a transient upstream failure for every lifecycle operation, including cleanup.

## Consequences

- SurfGate follows the newest Kitesurf selection contract while interoperating
  with Cloudflare's currently returned legacy connection namespace.
- Credentials remain server-side Authorization headers and never enter URLs,
  provider descriptors, session metadata, errors, or public responses.
- A Cloudflare namespace or response-shape change fails closed as
  `PROVIDER_INVALID_RESPONSE` until documentation and conformance fixtures are
  deliberately updated.
- The future SurfGate relay must resolve the opaque credential reference
  server-side and must never serialize the internal upstream URL to clients.
