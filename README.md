# Termyte

Termyte gives coding agents the project context they need, so developers do not have to repeatedly explain what happened, why, and what remains.

It runs locally, records agent work, checks current project state, and supplies relevant task context to later sessions. A local Viewer lets you inspect the captured work.

## Install

```bash
npm install -g termyte
termyte init
termyte viewer
```

`termyte init` connects Termyte to Claude Code, Codex, or OpenCode. You can use an agent's existing login, an OpenAI-compatible API, or capture events without creating memories.

Termyte stores its configuration and SQLite database in `~/.termyte`.

## Common commands

```text
termyte init
termyte viewer [--no-open]
termyte doctor [--json]
termyte task <create|show|add-step|verify-step|checkpoint|resume|handoff> [options]
termyte uninstall
termyte help
```

Use `termyte doctor` to check the database, hooks, background work, and recent traces. Use `termyte viewer` to inspect sessions, tasks, memories, context, and failures.

For task continuity:

```bash
termyte task create --repo <repo-id> --title "Fix login" --objective "Restore login"
termyte task add-step --task <task-id> --title "Reproduce failure" --position 1 --version 1
termyte task checkpoint --task <task-id> --workspace <repo-path> --platform codex
termyte task resume --task <task-id> --workspace <repo-path>
```

## Configuration

The main environment variables are:

| Variable | Purpose |
| --- | --- |
| `TERMYTE_DB` | SQLite database path |
| `TERMYTE_LLM_BASE_URL` | OpenAI-compatible API address |
| `TERMYTE_LLM_API_KEY` | API key |
| `TERMYTE_LLM_MODEL` | Model used to process observations |
| `TERMYTE_EMBED_MODEL_LOCAL` | Local model used for search |
| `TERMYTE_AUTO_WORKER` | Set to `0` to disable the background worker |

## How it works

```text
agent events -> capture and normalization -> local SQLite storage
  -> context extraction -> indexing and retrieval
  -> task-specific context supplied to the agent
```

Hooks capture events first. Background work turns completed sessions into observations and memories. At session start, Termyte combines task state, stored evidence, and current Git state into the handoff supplied to the agent.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run verify
```

See [`docs/getting-started.md`](docs/getting-started.md) for setup details and [`docs/how-it-works.md`](docs/how-it-works.md) for the processing flow.

## Current limits

- Redaction helps remove secrets but is heuristic; review captured data before sharing it.
- OpenCode capture works, but automatic context injection is not supported.
- Search ranking has not been calibrated against a public coding-agent dataset.
- Retrieved history is context, not proof that it caused a later result.
- Strong claims about productivity still need controlled paired-agent trials.

## License

MIT. See [`LICENSE`](LICENSE).
