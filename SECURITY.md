# Security Policy

Termyte runs locally on developer machines and stores its data in a local SQLite file. Security issues still matter: a malicious payload that reaches the LLM during synthesis, a path-traversal bug in a file extractor, or a config-injection issue in an installer could affect users. Please report any vulnerability privately.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | yes |
| 0.x | best effort |

## Reporting a vulnerability

Email: **palguna@termyte.xyz** (PGP key on request)

Please include:

- A clear description of the issue and the attack scenario.
- A minimal reproduction (commands, hook payload, or a synthetic test).
- The affected version, commit SHA, or release tag.
- Your assessment of impact (data exposure, RCE, LLM prompt injection, etc.).
- Whether you intend to disclose publicly and on what timeline.

We will:

1. Acknowledge within **3 business days**.
2. Triage within **7 days** and give you a severity assessment.
3. Coordinate a fix and a release. Critical issues get a patch release within 14 days; high-severity issues within 30 days.
4. Credit you in the release notes and security advisory (unless you prefer to remain anonymous).
5. Reserve a CVE via GitHub Security Advisories for confirmed vulnerabilities.

Please **do not** file a public GitHub issue, discussion, or social-media post until we have agreed on a disclosure date. Premature disclosure can put users at risk.

## Out of scope

- Reports that require the user to have already executed attacker-controlled code with full write access to the `termyte.db` file.
- Denial-of-service via local resource exhaustion (filling the SQLite file, etc.) by the local user.
- Theoretical LLM-prompt-injection scenarios that require the user to copy a malicious trace into their own database.
- Issues in upstream dependencies (`better-sqlite3`, `@xenova/transformers`, `sqlite-vec`). Please report those to the upstream maintainers.

## Security design notes

For context on how Termyte is built to minimize risk:

- The database is a local SQLite file. There is no network listener.
- The only outbound call is the synthesis LLM, which the user explicitly opts into and is rate-limited by daily budget caps.
- Hook inputs are parsed with conservative regexes and are never passed to `eval` or template interpolation.
- Installers back up any user-edited config file before overwriting (see `src/integrations/installers/backup.ts`).
- Embeddings are computed locally via ONNX; no embedding payload ever leaves the machine unless the user has configured an external embedding API.
