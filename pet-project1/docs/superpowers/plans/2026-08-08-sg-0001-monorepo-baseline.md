# SG-0001 Monorepo Baseline Implementation Plan

> **For agentic workers:** Execute these tasks inline in the current repair worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Node.js 24, pnpm, TypeScript, ESLint, Prettier, Vitest, and Turbo monorepo foundation required by SG-0001 without implementing SurfGate product behavior.

**Architecture:** The repository root owns shared tool versions and quality commands. Every app and package documented in `docs/ARCHITECTURE.md` is an independent private pnpm workspace with the same build/lint/test/typecheck interface; `packages/testing` contains the only executable fixture needed to prove compilation and Vitest execution.

**Tech Stack:** Node.js 24 LTS, pnpm 10.15.1, TypeScript 5.9, ESLint 9, typescript-eslint 8, Prettier 3, Vitest 3, Turbo 2.

## Global Constraints

- Implement SG-0001 only; do not begin SG-0002.
- Do not implement routing, providers, Cloudflare, Kitesurf, Chromium, APIs, authentication, databases, Redis, relay behavior, or task execution.
- Preserve all documented app/package boundaries.
- TypeScript must enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `useUnknownInCatchVariables`.
- `pnpm check` must run formatting, lint, typecheck, unit tests, and build.
- Leave repository changes uncommitted for review.

---

### Task 1: Root toolchain and quality gate

**Files:**
- Create: `.node-version`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `vitest.config.ts`
- Modify: `package.json`
- Verify: `pnpm-workspace.yaml`
- Verify: `tsconfig.base.json`
- Modify: `turbo.json`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: Node.js `>=24 <25` and pnpm `10.15.1`.
- Produces: root commands `format:check`, `lint`, `typecheck`, `test`, `build`, and `check`.

- [x] **Step 1: Run the pre-implementation foundation assertion**

Run a read-only shell assertion checking for Prettier/Vitest configuration and all workspace manifests.

Expected: FAIL because the baseline files are absent.

- [x] **Step 2: Configure Node.js, Prettier, Vitest, ESLint, and Turbo**

Use `.node-version` value `24`, Prettier settings `{ "semi": false, "singleQuote": true, "trailingComma": "all", "printWidth": 100 }`, and Vitest settings `environment: "node"`, `clearMocks: true`, `passWithNoTests: true`, and `include: ["test/**/*.test.ts"]`.

Keep the root quality gate exactly ordered as formatting, lint, typecheck, unit tests, then build.

- [x] **Step 3: Verify shared TypeScript strictness**

Run a JSON assertion that confirms every compiler flag required by `AGENTS.md` is `true` in `tsconfig.base.json`.

Expected: PASS.

### Task 2: Workspace boundaries and compilation

**Files:**
- Create: `apps/{api,relay,worker}/package.json`
- Create: `apps/{api,relay,worker}/tsconfig.json`
- Create: `apps/{api,relay,worker}/src/index.ts`
- Create: `packages/{contracts,config,router,provider-core,provider-kitesurf,provider-chromium,security,observability,testing}/package.json`
- Create: `packages/{contracts,config,router,provider-core,provider-kitesurf,provider-chromium,security,observability,testing}/tsconfig.json`
- Create: `packages/{contracts,config,router,provider-core,provider-kitesurf,provider-chromium,security,observability}/src/index.ts`
- Create: `packages/testing/tsconfig.build.json`
- Create: `packages/testing/src/index.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json`, `eslint.config.mjs`, and `vitest.config.ts`.
- Produces: twelve private workspaces exposing `build`, `lint`, `test`, and `typecheck` scripts.

- [x] **Step 1: Add manifests with uniform commands**

Each manifest uses `"type": "module"`, `"private": true`, and these commands:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint . --max-warnings 0",
    "test": "vitest run --config ../../vitest.config.ts --root .",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

`packages/testing` uses `tsc -p tsconfig.build.json` for build so its test-aware `tsconfig.json` remains no-emit.

- [x] **Step 2: Add strict workspace TypeScript configs**

Normal workspaces extend `../../tsconfig.base.json`, compile `src/**/*.ts` from `src` to `dist`, and store incremental metadata in `dist/tsconfig.tsbuildinfo`. `packages/testing/tsconfig.json` includes both `src/**/*.ts` and `test/**/*.ts`; its build config narrows emission to `src`.

- [x] **Step 3: Add minimal compilation entries**

All non-testing workspaces contain only:

```ts
export {}
```

No product interfaces or behavior are introduced.

### Task 3: Red-green workspace test and final gates

**Files:**
- Create first: `packages/testing/test/foundation.test.ts`
- Create after the test fails: `packages/testing/src/index.ts`
- Update: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Vitest and the `@surfgate/testing` workspace.
- Produces: one deterministic test proving workspace source compilation and test execution.

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'

import { FOUNDATION_STATUS } from '../src/index.js'

describe('workspace foundation', () => {
  it('loads TypeScript source through Vitest', () => {
    expect(FOUNDATION_STATUS).toBe('workspace-ready')
  })
})
```

- [x] **Step 2: Run the focused test and verify RED**

Run `pnpm --filter @surfgate/testing test`.

Expected: FAIL because `FOUNDATION_STATUS` is not exported.

- [x] **Step 3: Add the minimal fixture**

```ts
export const FOUNDATION_STATUS = 'workspace-ready' as const
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run `pnpm --filter @surfgate/testing test`.

Expected: one passing test.

- [x] **Step 5: Run all required acceptance commands**

Run, in order: `pnpm install`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check` under Node.js 24.

Expected: every command exits 0 and `pnpm check` exercises all twelve workspaces.

- [x] **Step 6: Review scope and security**

Inspect all changed files, verify `.env` and generated outputs remain ignored, run a high-signal secret scan, and confirm no SG-0002 or product behavior was introduced.
