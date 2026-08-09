# Contributing to SurfGate

Start with the product documentation and relevant architecture decision records in `docs/`.

## Before opening a change

- choose one bounded concern,
- check relevant docs/ADRs,
- add tests,
- do not include secrets.

## Quality

Expected:

```bash
pnpm check
```

When relevant:

```bash
pnpm test:integration
pnpm test:conformance
```

Live provider tests require protected credentials and should not run from untrusted fork PRs.

## Architecture

Changes to:
- public API,
- routing semantics,
- service boundaries,
- auth/token format,
- data stores

should include/update an ADR.

## Pull request

Explain:
- problem,
- implementation,
- tests,
- security impact,
- observability impact,
- migration/deployment impact.

Avoid unrelated refactors.
