# Examples

These examples use local SurfGate credentials only. They never need or receive the Cloudflare provider token.

- [`basic-session`](basic-session/) creates and later terminates a capability-driven session.
- [`playwright-cdp`](playwright-cdp/) obtains a short-lived relay credential and connects Playwright Core through SurfGate.
- [`managed-task`](managed-task/) submits and polls a task, then downloads an artifact when applicable.

Complete [Getting Started](../docs/GETTING_STARTED.md) first. Set `SURFGATE_API_KEY` in your shell; do not put secrets in these files.
