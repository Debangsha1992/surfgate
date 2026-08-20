# Security Policy

## Reporting a vulnerability

GitHub Private Vulnerability Reporting is not currently enabled for this repository. Enabling it is a required repository setup action before the `v0.1.0` preview.

Once GitHub's **Security** tab offers **Report a vulnerability**, use that private workflow:

<https://github.com/Debangsha1992/surfgate/security/advisories/new>

Include affected components, impact, reproduction steps, and a suggested mitigation when possible. Remove API keys, tokens, cookies, provider URLs, page content, and other secrets from evidence.

Until then, do not put undisclosed vulnerability details in a public issue. Open a minimal issue asking a repository maintainer to establish a private channel without including vulnerability or exploitation details.

This experimental developer preview does not promise a fixed response or disclosure timeline. Maintainers will acknowledge and triage reports as capacity permits.

## Security boundary

Read the [SurfGate Security Model](docs/SECURITY_MODEL.md) before deploying the project. Its raw-CDP network-isolation limitation is especially important.
