# Getting Started

## Install

Install Termyte and connect Claude Code, Codex, or OpenCode:

```bash
npm install -g termyte
termyte init
termyte viewer
```

`termyte init` detects supported agents, installs the selected integrations, and configures synthesis. OpenCode currently supports capture, not synthesis.

## Verify

Run the local health checks:

```bash
termyte doctor
termyte viewer
```

`termyte doctor` reports database, hook, synthesis, queue, and trace health.

## Use

The Viewer exposes sessions, episodes, context packets, memories, provenance, outcomes, and diagnostics.

For durable task continuity:

```bash
termyte task create --repo <repo-id> --title "Fix login" --objective "Restore login"
termyte task add-step --task <task-id> --title "Reproduce failure" --position 1 --version 1
termyte task checkpoint --task <task-id> --workspace <repo-path> --platform codex
termyte task resume --task <task-id> --workspace <repo-path>
termyte task handoff --task <task-id> --source codex --target opencode --workspace <repo-path>
```

Task commands emit JSON. IDs and the current optimistic-lock version come from the preceding command output.

## Configuration

The most important environment variables are:

- `TERMYTE_DB` - SQLite database path
- `TERMYTE_LLM_BASE_URL` - OpenAI-compatible chat endpoint
- `TERMYTE_LLM_API_KEY` - chat endpoint credential
- `TERMYTE_LLM_MODEL` - observation and consolidation model
- `TERMYTE_EMBED_MODEL_LOCAL` - local embedding model
- `TERMYTE_AUTO_WORKER` - set to `0` to disable detached worker startup

## Practical Rule

Use Termyte to capture what happened and make prior coding experience inspectable, not as a substitute for judgment.
Retrieved experience is context, not ground truth.
