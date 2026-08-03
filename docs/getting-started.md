# Getting started

Install Termyte globally, open the repository you want it to watch, and run:

```bash
npm install -g termyte
termyte init
```

Choose Claude Code or Codex if both are installed. Termyte writes project hooks and prints one confirmation.

Termyte creates `.claude/settings.json` or `.codex/hooks.json` in the current project. It also creates `~/.termyte/config.json` and a local SQLite database.

Work normally. Capture is silent. When the next session starts in the same repository, Termyte creates and injects a handoff from the previous session before the agent's first response.

## Recall earlier work

Ask a question such as:

```text
Why did we choose this approach?
What happened last time?
What did we try before?
```

Termyte searches saved handoffs from the current repository with SQLite FTS5 and injects up to three matches. This is keyword search, not semantic search.

## Data and privacy

Termyte stores redacted prompts, tool activity, outputs, and final responses locally. Redaction covers common secret patterns but cannot guarantee that every secret will be removed. Review the project hooks and local database policy before using Termyte with sensitive repositories.
