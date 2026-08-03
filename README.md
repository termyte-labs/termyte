# Termyte

Termyte gives coding agents the project context they need, so developers do not have to repeatedly explain what happened, why, and what remains.

It is a local-first session handoff tool for Claude Code and Codex. It captures work in one session and gives the next session a handoff before the agent's first response.

## Setup

From the repository you want Termyte to watch:

```bash
npm install -g termyte
termyte init
```

Termyte connects to an existing Claude Code or Codex installation. It uses that agent's existing login. It does not require another subscription or API key.

## What happens

During a session, hooks silently store redacted prompts, tool calls, outputs, file activity, and the final response in local SQLite.

At the next session start, Termyte builds a deterministic handoff from the latest previous session and current Git state. It includes the previous request, final response, recent tool actions, changed files, branch, and commit when available. No extra model call is made.

Questions such as "why did we choose this?" can retrieve prior handoffs through SQLite FTS5 full-text search. Search is limited to the current repository and returns up to three handoffs.

## Current limits

- Search uses basic keyword matching and SQLite BM25 ranking. It is not semantic or vector search.
- Recall searches saved handoffs, not every raw event.
- An empty or failed session may become the most recent session selected for a handoff.
- Previous prompts and final responses do not yet have a total handoff-size limit.
- Redaction is heuristic and may not catch every secret format.
- There is no cloud sync, dashboard, background worker, or cross-device history.

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

Termyte stores captured data in local SQLite. The selected coding agent receives the redacted handoff through its session hook.
