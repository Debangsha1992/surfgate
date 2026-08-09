# packages/provider-kitesurf

`@surfgate/provider-kitesurf` implements the provider-core `BrowserProvider`
contract for Cloudflare Browser Run's Kitesurf runtime.

Cloudflare authentication, bounded transport, lifecycle validation, cleanup,
and idempotent termination are shared with the Chromium adapter through the
private `@surfgate/provider-cloudflare` package. Runtime selection and the
capability declaration remain owned by this package; neither concrete provider
depends on the other.

Construct the adapter from the validated configuration boundary:

```ts
import { loadConfig } from '@surfgate/config'
import { createKitesurfBrowserProvider } from '@surfgate/provider-kitesurf'

const config = loadConfig()
const provider = createKitesurfBrowserProvider(config.cloudflare)
```

The provider never reads `process.env`. When the Cloudflare credential pair is
absent, its descriptor is unconfigured, health is `PROVIDER_NOT_CONFIGURED`, and
allocation fails with the normalized configuration error.

Current lifecycle contract:

- allocate with `POST /accounts/{account}/browser-run/devtools/browser` and the
  `browser=kitesurf` selector;
- request an inactivity `keep_alive` matching the SurfGate session duration, up
  to the documented ten-minute Kitesurf policy;
- accept only a clean `wss://api.cloudflare.com` session URL for the configured
  account and returned session ID;
- tolerate Cloudflare's currently returned legacy `/browser-rendering` WSS
  namespace while continuing to send lifecycle calls to `/browser-run`;
- terminate with `DELETE /accounts/{account}/browser-run/devtools/browser/{id}`;
- coalesce concurrent termination, retain only a bounded short-lived record for
  sequential idempotency, and treat upstream `404` as `already_terminated`;
- best-effort terminate a session when allocation returned a valid session ID
  but unsafe or malformed connection metadata.

Kitesurf's documented JavaScript, DOM, XHR, SVG, screenshot, and PDF behavior
is declared `experimental` while the runtime is beta. Requests must explicitly
set `allowExperimental`; WebGL, video, persistent authentication, real-browser
TLS challenge behavior, multiple tabs, and long sessions remain unsupported.

The API token exists only inside the transport and is attached as a Bearer
header. It is not part of descriptors, sessions, metadata, diagnostics, or
errors. Returned WSS URLs are internal `ProviderSession` connection data and
must eventually be consumed by SurfGate's relay, never serialized to clients.

Run deterministic tests and the exact shared conformance suite:

```bash
pnpm --filter @surfgate/provider-kitesurf test
pnpm --filter @surfgate/provider-kitesurf test:conformance
```

The separately selected live lifecycle test loads credentials through
`@surfgate/config`, skips when they are absent, and always terminates in
`finally`:

```bash
pnpm --filter @surfgate/provider-kitesurf test:live
```
