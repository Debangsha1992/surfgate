# packages/contracts

Provider-neutral public/internal schemas and stable error/capability contracts.

This package is the runtime-validation boundary shared by SurfGate APIs, routers,
providers, SDKs, and tests. Zod schemas are the source of truth and exported
TypeScript types are inferred from them; callers should parse external values
before treating them as contract types.

Implemented contract groups:

- opaque, prefix-validated SurfGate IDs;
- stable public error codes, canonical messages, strictly allowlisted public
  details, and the provider-neutral error response;
- browser capability names, support/requirement states, runtime selection flags,
  exhaustive provider declarations, and hard-requirement satisfaction semantics.

The package deliberately has no API framework, database, Redis, Cloudflare,
browser automation, or provider-implementation dependencies. Zod is its only
runtime dependency because these public boundaries require runtime parsing as
well as compile-time types.
