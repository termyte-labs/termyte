# Security policy

Please do not report security problems in a public issue.

Use [GitHub's private vulnerability reporting](https://github.com/termyte-labs/termyte/security/advisories/new) when it is available. Include the affected version, the steps to reproduce the problem, and any safe proof that helps us confirm it. Remove secrets and personal data before sending details.

The latest version on the `main` branch is the only version currently supported with security fixes.

## Local data

Termyte stores captured prompts, tool inputs, tool outputs, file activity, final responses, and handoffs in local SQLite. Common secrets are redacted before storage, but redaction is heuristic and may miss unknown formats.

Do not include real credentials in a security report. If a report needs a secret-like value to reproduce a redaction issue, use a fake value with the same format.
