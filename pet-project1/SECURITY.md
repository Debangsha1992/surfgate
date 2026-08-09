# Security Policy

SurfGate is browser infrastructure and should be treated as security-sensitive.

## Reporting

Before public release, configure a private security reporting channel in the repository hosting platform and replace this section with the final contact/process.

Do not publish exploitable security issues in a public issue before coordinated review.

## Sensitive areas

Especially sensitive:
- tenant authorization,
- SSRF/private-network controls,
- provider credentials,
- relay tokens,
- WebSocket relay,
- session isolation,
- artifact authorization,
- log redaction.

See:
- `docs/SECURITY.md`
- `docs/THREAT_MODEL.md`
