# Termyte

Termyte is a local-first experience layer for Codex and Claude Code. It learns compact, evidence-linked lessons from completed coding sessions and applies useful experience to future work in the same repository.

## Setup

From the repository you want Termyte to watch:

```bash
npm install -g termyte
termyte init
```

Termyte detects installed supported agents and installs project hooks for each one. When both are installed, you choose which existing agent login Termyte should use for reflection and relevance selection. No separate API key is required.

## Experience loop

1. Hooks silently capture redacted prompts, tool activity, files, commands, results, responses, and repository identity in local SQLite.
2. A meaningful completed session enqueues an idempotent reflection job.
3. A detached worker asks the selected coding agent to create one concise experience grounded in the saved trace evidence.
4. Every new session receives a project briefing built from repository files, Git state, recent tasks, and experience from earlier sessions.
5. Every prompt considers the repository's compact experience catalogue. Relevant full records and supporting evidence are injected before the coding agent handles the request.

If reflection or context generation fails, the coding agent continues normally. Prompt selection falls back to local keyword relevance when the selected agent is unavailable.

## Privacy and limits

- Raw sessions, experience, and job state stay in local SQLite.
- Common secret formats are redacted before persistence, but redaction cannot guarantee detection of every secret.
- Termyte uses existing agent logins; those agent providers may receive redacted session evidence during reflection and compact context during selection.
- Context limits are configurable in `~/.termyte/config.json` through `briefingTokenLimit`, `promptTokenLimit`, `catalogueTokenLimit`, and `selectionTimeoutMs`.
- Termyte does not train model weights and has no cloud sync, embeddings, vector database, dashboard, or team workspace.

## Development

```bash
npm run verify
```

See [how it works](docs/how-it-works.md) and [getting started](docs/getting-started.md).
