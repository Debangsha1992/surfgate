# SG-0002 and SG-0003 Infrastructure and Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide deterministic local PostgreSQL and Redis infrastructure plus one runtime-validated, secret-safe configuration boundary for SurfGate.

**Architecture:** `docker-compose.dev.yml` owns only local PostgreSQL and Redis, with fixed development ports, pinned image versions, durable named volumes, and health checks. `@surfgate/config` parses one environment-shaped input into concern-grouped readonly objects; its loader optionally layers the repository `.env` beneath the process environment in non-production modes, while production reads only the process environment.

**Tech Stack:** Node.js 24, TypeScript 5.9, pnpm 10.15.1, Vitest 3, Docker Compose, PostgreSQL 17, Redis 8.

## Global Constraints

- Implement only SG-0002 and SG-0003; do not begin SG-0101 or any provider, routing, API, schema, authentication, or relay implementation.
- Keep `packages/config` as the only production location that reads `process.env`.
- Never include environment values in configuration validation errors.
- Do not commit a real `.env` file or start containers from application startup scripts.
- Preserve Node.js 24 and every strict TypeScript option in `AGENTS.md`.

---

### Task 1: Specify configuration behavior with failing tests

**Files:**
- Create: `packages/config/test/config.test.ts`
- Create: `packages/config/test/load-config.test.ts`
- Modify: `packages/config/tsconfig.json`
- Create: `packages/config/tsconfig.build.json`
- Modify: `packages/config/package.json`

**Interfaces:**
- Consumes: environment-shaped `Readonly<Record<string, string | undefined>>` inputs.
- Produces: desired `parseConfig(environment)` and `loadConfig(options)` behavior.

- [x] **Step 1: Write parsing tests before production code**

  Add focused tests for a valid development configuration, missing `DATABASE_URL`, non-integer and out-of-range ports, invalid database/Redis/relay/object-storage/telemetry URLs, absent and complete Cloudflare credentials, incomplete Cloudflare credentials, and secret redaction.

- [x] **Step 2: Write local `.env` behavior tests before production code**

  Use a temporary `.env` file to prove local values load, explicit environment values override file values, and production ignores the file.

- [x] **Step 3: Run the focused test and verify RED**

  Run `pnpm --filter @surfgate/config test`; expect failure because `parseConfig`, `loadConfig`, and `ConfigurationError` are not exported.

### Task 2: Implement the single configuration boundary

**Files:**
- Create: `packages/config/src/configuration-error.ts`
- Create: `packages/config/src/types.ts`
- Create: `packages/config/src/validation.ts`
- Create: `packages/config/src/load-config.ts`
- Modify: `packages/config/src/index.ts`

**Interfaces:**
- Consumes: environment-shaped records and, only in `loadConfig`, `process.env` plus an optional trusted `.env` path.
- Produces: `SurfGateConfig`, `parseConfig`, `loadConfig`, `ConfigurationError`, and sanitized `ConfigurationIssue` objects.

- [x] **Step 1: Implement sanitized errors**

  `ConfigurationError` must expose stable code `CONFIGURATION_INVALID`, list only variable names and static validation messages, and never retain or interpolate rejected values.

- [x] **Step 2: Implement concern-grouped types and parsing**

  Return readonly `runtime`, `api`, `relay`, `database`, `redis`, `objectStorage`, `telemetry`, and `cloudflare` objects. Validate required strings, enum values, ports from 1 through 65535, URL protocols, and all-or-nothing optional credential pairs.

- [x] **Step 3: Implement safe local `.env` loading**

  In development/test, parse the repository `.env` with Node 24 APIs and merge process variables over file values. In production, ignore `.env` completely. Convert file read/parse failures to sanitized configuration errors.

- [x] **Step 4: Run focused tests and verify GREEN**

  Run `pnpm --filter @surfgate/config test`, `pnpm --filter @surfgate/config typecheck`, and `pnpm --filter @surfgate/config lint`; expect all tests and checks to pass.

### Task 3: Complete deterministic local infrastructure and documentation

**Files:**
- Modify: `docker-compose.dev.yml`
- Create: `.env.example`
- Modify: `docs/LOCAL_DEVELOPMENT.md`
- Modify: `packages/config/README.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: documented SurfGate defaults `5432`, `6379`, `8080`, and `8081`.
- Produces: exact infrastructure lifecycle commands and an environment template matching every supported variable.

- [x] **Step 1: Pin and harden the two development services**

  Keep only PostgreSQL and Redis, bind their default ports to localhost, pin exact image versions, retain named volumes, define deterministic commands/environment, and keep health checks.

- [x] **Step 2: Document supported variables and lifecycle commands**

  Add `.env.example`; document `docker compose -f docker-compose.dev.yml up -d`, `docker compose -f docker-compose.dev.yml ps`, and `docker compose -f docker-compose.dev.yml down`. State that application startup does not start infrastructure.

- [x] **Step 3: Update dependencies and formatting scope**

  Add direct Node 24 type definitions, update the lockfile, and include the changed Compose and local-development files in root formatting checks.

- [x] **Step 4: Validate Compose without starting services**

  Run `docker compose -f docker-compose.dev.yml config --quiet` and inspect the rendered service list, ports, and health checks.

### Task 4: Review and verify the complete slice

**Files:**
- Modify: `docs/superpowers/plans/2026-08-08-sg-0002-sg-0003-infrastructure-config.md`

**Interfaces:**
- Consumes: the complete SG-0002/SG-0003 change.
- Produces: review findings and fresh acceptance evidence.

- [x] **Step 1: Audit boundaries and secrets**

  Search production sources for `process.env`, scan for high-signal credentials, confirm `.env` is ignored and `.env.example` is tracked, and verify no SG-0101/product logic exists.

- [x] **Step 2: Request independent code review**

  Ask a read-only reviewer to check validation correctness, redaction, `.env` precedence, production behavior, Compose safety, documentation, and scope. Resolve all Critical and Important findings.

- [x] **Step 3: Run repository acceptance commands**

  Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check` under Node 24.

- [x] **Step 4: Validate runtime infrastructure when available**

  If Docker can pull and run the pinned images, start only PostgreSQL and Redis, wait for healthy status, then run `docker compose -f docker-compose.dev.yml down` and confirm no containers remain. Otherwise report the exact Docker blocker after keeping static Compose validation green.
