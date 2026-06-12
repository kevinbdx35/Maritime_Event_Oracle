# Security Policy

## Supported versions

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Use GitHub's private vulnerability reporting instead: go to the
[Security tab](../../security/advisories/new) of this repository and click
**"Report a vulnerability"**. You will get a response within 7 days.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (a curl command or minimal script is ideal)
- Affected component (`apps/api`, `apps/ingestor`, `apps/anchor-worker`,
  `packages/core`, or `contracts/`)

## Scope notes

- The signing key (`EVT_SIGNING_KEY`) and the anchoring key
  (`ANCHOR_PRIVATE_KEY`) are the trust roots of this oracle — any issue
  allowing their disclosure or misuse is in scope and high severity.
- The on-chain contracts (`contracts/src/`) are in scope.
- Denial of service on the public dashboard endpoints is a known,
  accepted risk for now (see README architecture notes).
