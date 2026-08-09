# packages/config

`@surfgate/config` is the single boundary for SurfGate environment configuration.

Use `loadConfig()` once during service startup. It loads the repository `.env` in development and
test modes, lets process variables override local file values, and uses only process variables in
production. `parseConfig()` is available for callers that already have an environment-shaped input
and for deterministic tests.

The resulting readonly object separates runtime/logging, API, relay, database, Redis, object
storage, telemetry, and Cloudflare settings. Invalid configuration throws `ConfigurationError`
with code `CONFIGURATION_INVALID`; issues contain variable names and static messages but never
rejected values.

Production mode is selected only by the process environment and requires secure transports:
`wss:` for the relay, `rediss:` for Redis, `sslmode=require`, `verify-ca`, or `verify-full` for
PostgreSQL, and HTTPS for configured object-storage, telemetry, and Cloudflare endpoints.

Supported variables and safe local defaults are documented in the repository `.env.example`.
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_BROWSER_RUN_API_TOKEN` remain optional as a pair; when
both are absent the Cloudflare providers report not configured. The token remains available only
inside the readonly Cloudflare configuration concern and is never included in validation issues.

Production also requires `SURFGATE_PROVIDER_SESSION_ENCRYPTION_KEY`, exactly 32 random bytes
encoded as canonical base64. The decoded key is held as a non-serializing `KeyObject`; an optional
safe key ID defaults to `v1`. Development may omit it until encrypted provider-session persistence
is exercised. `TEST_DATABASE_URL` is optional and used only by the explicitly gated integration
suite, which independently requires a database name ending in `_test`.
