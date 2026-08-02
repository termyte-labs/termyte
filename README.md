# Termyte

Termyte gives coding agents the project context they need, so developers do not have to repeatedly explain what happened, why, and what remains.

## Setup

From the repository you want Termyte to watch:

```bash
npm install -g termyte
termyte init
```

Termyte connects to an existing Claude Code or Codex installation. It uses that agent's existing login. It does not require another subscription or API key.

## What happens

During a session, hooks silently store redacted prompts, tool calls, outputs, file activity, and the final response in local SQLite.

At the next session start, Termyte gives the selected agent one bounded prompt containing the previous session's evidence and current Git state. The resulting handoff tells the agent what happened, why, what remains, and the immediate next step. The handoff is injected before the agent's first response.

Explicit questions such as “why did we choose this?” can retrieve prior handoffs through local SQLite full-text search.

## Commands

```text
termyte init
termyte help
```

## Development

```bash
npm run typecheck
npm test
npm run build
npm run test:package
```

Redaction is heuristic. Termyte stores data locally, but the selected coding agent receives redacted session evidence when it creates the next-session handoff.
