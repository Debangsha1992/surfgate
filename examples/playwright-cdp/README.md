# Playwright Core through the SurfGate relay

Create an active session, then run:

```bash
SURFGATE_API_KEY='sg_test_...' \
SURFGATE_SESSION_ID='ses_...' \
SURFGATE_EXAMPLE_URL='https://example.com/' \
node examples/playwright-cdp/index.mjs
```

The client receives only a short-lived SurfGate token. The provider credential and upstream CDP URL remain server-side.

This example navigates with raw CDP. Review the [raw-CDP security limitation](../../docs/SECURITY_MODEL.md) before using it with untrusted principals.
