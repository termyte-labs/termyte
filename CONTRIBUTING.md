# Contributing

Thanks for helping improve Termyte.

## Before you start

For a large change, open an issue first so the scope is clear. Small fixes and documentation changes can go straight to a pull request.

## Local setup

Requirements:

- Node.js 20 or newer
- npm

```bash
npm install
npm run verify
```

`npm run verify` checks the TypeScript, builds the project, and runs the tests, including the installed-package test.

## Source layout

- `src/agents` - Claude Code and Codex adapters, hooks, and installers
- `src/capture` - event normalization, file extraction, and session recording
- `src/context` - deterministic handoff building and recall
- `src/storage` - SQLite connection, migrations, traces, handoffs, and FTS5 search
- `src/cli` - terminal commands and hook entrypoints
- `src/shared` - cross-cutting types and redaction

The current MVP has no worker, task system, MCP server, viewer, embeddings, or cloud sync.

## Pull requests

- Keep each pull request focused.
- Add or update tests when behavior changes.
- Add an end-to-end test when changing Session 1 to Session 2 handoff behavior.
- Update the README or docs when user-facing behavior changes.
- Explain any migration, compatibility, or security impact.
- Do not include database files, logs, credentials, or generated `dist` changes unless the change specifically requires them.

Please describe what changed, why it changed, and how you checked it.
