# packages/provider-chromium

Cloudflare Browser Run Chromium adapter for SurfGate's provider-neutral
`BrowserProvider` contract.

The provider:

- uses Chromium's current `/browser-rendering/devtools` session API without a
  Kitesurf selector;
- receives validated Cloudflare configuration from `@surfgate/config` and never
  reads environment variables directly;
- delegates bounded Cloudflare transport and lifecycle mechanics to the private
  `@surfgate/provider-cloudflare` package;
- validates session responses and accepts only clean Cloudflare-owned CDP WSS
  endpoints;
- treats `keep_alive` as an inactivity window capped at ten minutes while
  retaining the caller's longer absolute session expiry;
- implements cancellation, normalized errors, bounded cleanup, and idempotent
  termination.

Run deterministic tests and the exact shared provider conformance suite:

```bash
pnpm --filter @surfgate/provider-chromium test
pnpm --filter @surfgate/provider-chromium test:conformance
```

The separately gated live lifecycle test loads the credential pair through
`@surfgate/config`, skips when unavailable, and always terminates an allocated
session in `finally`:

```bash
pnpm --filter @surfgate/provider-chromium test:live
```
