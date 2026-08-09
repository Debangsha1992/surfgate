# Local Environment Repair Implementation Plan

> **For agentic workers:** Execute these steps inline in this repair worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the missing SurfGate worktree contents and make its Codex setup select the installed Node.js 24 runtime safely.

**Architecture:** Materialize the original untracked SurfGate source snapshot at the expected nested worktree path, excluding generated macOS metadata. Add repository ignore rules, then adjust the generated local setup script to prepend the known Homebrew Node.js 24 directory before validating and installing dependencies.

**Tech Stack:** Git worktrees, Bash, TOML, Node.js 24, Corepack, pnpm 10.15.1.

## Global Constraints

- Do not continue the original SurfGate implementation request.
- Do not modify the original source directory.
- Do not commit changes; leave the repair diff for user review.
- Do not copy `.DS_Store`, `.env`, credentials, or generated dependency/build directories.
- Keep Node.js at the version required by `package.json`: `>=24 <25`.

---

### Task 1: Restore the repair-worktree snapshot

**Files:**
- Create: the SurfGate files currently present under `/Users/debangsha/Documents/pet-project1`
- Exclude: `.DS_Store`, `.git`, `.env`, `node_modules`, `.turbo`, `.cache`

**Interfaces:**
- Consumes: the original untracked SurfGate source snapshot.
- Produces: a reviewable `pet-project1/` tree inside the current parent Git worktree.

- [x] **Step 1: Verify the repair path is incomplete**

Run `test -f AGENTS.md && test -f package.json && test -f .codex/environments/environment.toml` from the repair root.

Expected: non-zero exit because the snapshot has not been restored.

- [x] **Step 2: Preview the snapshot transfer**

Run `rsync -ani --exclude=.git --exclude=.DS_Store --exclude=.env --exclude=node_modules --exclude=.turbo --exclude=.cache /Users/debangsha/Documents/pet-project1/ ./`.

Expected: only SurfGate source and configuration files are listed.

- [x] **Step 3: Materialize the snapshot**

Run the same command with `-a` instead of `-ani`, preserving the plan already created in this worktree.

- [x] **Step 4: Verify required files exist**

Run `test -f AGENTS.md && test -f package.json && test -f pnpm-workspace.yaml && test -f .codex/environments/environment.toml`.

Expected: exit 0.

### Task 2: Harden and verify local setup

**Files:**
- Create: `.gitignore`
- Create: `pnpm-lock.yaml`
- Modify: `.codex/environments/environment.toml`

**Interfaces:**
- Consumes: Homebrew `node@24`, discovered with `brew --prefix node@24`.
- Produces: a setup process that selects Node.js 24 before its existing version check.

- [x] **Step 1: Verify the current setup fails its Node requirement**

Run the setup's Node version check under the inherited PATH.

Expected: Node.js major version `22`, not required version `24`.

- [x] **Step 2: Add ignore rules**

Create `.gitignore` with exclusions for macOS metadata, `.env` files except `.env.example`, dependencies, package-manager cache, build outputs, test coverage, and logs.

- [x] **Step 3: Select Node.js 24 in the setup script**

Detect `node@24` with `brew --prefix node@24`, prepend its `bin` directory when present, and retain the strict Node.js major-version check.

- [x] **Step 4: Verify syntax and behavior**

Parse the TOML, run `bash -n` against both embedded scripts, and execute the setup in the repair worktree.

Expected: Node.js `v24.19.0`, pnpm `10.15.1`, dependency installation succeeds, and `.env` is created but ignored.

- [x] **Step 5: Review the proposed repair**

Run `git status --short`, `git diff --check`, and a secret scan. Confirm no source outside the repair worktree changed and leave all changes uncommitted.
