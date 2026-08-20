# Contributing to SurfGate

Thanks for helping with this experimental developer preview. Contributions are accepted under the repository's `AGPL-3.0-only` license.

## Workflow

1. Fork and clone the repository.
2. Create a focused branch from current `main`.
3. Install Node.js 24 and run `corepack enable`.
4. Install dependencies with `pnpm install --frozen-lockfile`.
5. Add tests before implementation when behavior changes.
6. Run `pnpm check` and any focused integration/conformance suite.
7. Update public documentation when a contract or workflow changes.
8. Open a pull request explaining the problem, solution, tests, and security impact.

Never include real credentials, `.env`, page data, cookies, raw CDP payloads, or secret-bearing URLs in an issue, test fixture, log, or PR.

Useful contributions include new runtime proposals, routing experiments, Kitesurf compatibility work, managed-task improvements, developer experience, documentation, and defensive security improvements.

## Architecture rules

1. Public contracts remain provider-neutral.
2. Kitesurf is a provider, not the architectural core.
3. Routing remains deterministic unless an explicit future policy changes that contract.
4. Provider credentials never reach clients.
5. Tenant resources remain tenant-scoped at service and repository boundaries.
6. Raw CDP payloads are never logged.
7. Retries and fallback are classified and bounded.
8. Every provider passes the shared conformance suite.
9. CAPTCHA bypass, fingerprint evasion, stealth, and anti-bot circumvention are out of scope.
10. Every external operation has an explicit timeout/cancellation model.

## Adding a provider

Implement the `provider-core` lifecycle in a dedicated package, declare capabilities conservatively, runtime-validate external data, normalize errors, protect internal connection metadata, register the provider outside the router, and run `pnpm test:conformance`. Read [docs/PROVIDERS.md](docs/PROVIDERS.md) first.

## Pull requests

Keep changes small enough to review. Explain migrations and compatibility impact, avoid drive-by refactors, and do not weaken security or quality gates. Integration tests must use isolated test infrastructure and must never target production.

For vulnerabilities, do not open a public issue; follow [SECURITY.md](SECURITY.md). Community participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
