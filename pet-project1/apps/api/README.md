# apps/api

SurfGate's Fastify control-plane foundation.

Implemented in SG-0501–SG-0503:

- liveness/readiness and graceful lifecycle;
- validated request IDs, canonical errors, redacted structured logs, telemetry hooks;
- tenant and salted-scrypt API-key persistence/authentication;
- explicit PostgreSQL migrations and tenant-scoped repositories;
- concurrency-safe session state transitions;
- validated, AES-256-GCM encrypted provider session references;
- persistence of the complete router `RoutingDecision` model.

The application does not run migrations or start infrastructure automatically.

```bash
pnpm --filter @surfgate/api db:migrate
pnpm --filter @surfgate/api test
TEST_DATABASE_URL=postgresql://surfgate:surfgate@127.0.0.1:5432/surfgate_test \
  pnpm --filter @surfgate/api test:integration
```

Production session endpoints and provider allocation begin in SG-0504 and are intentionally
absent here.
