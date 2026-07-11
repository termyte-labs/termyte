# Termyte

Termyte is a local context engine for Claude Code and Codex. It records agent execution, preserves evidence, derives repository-specific memories, and quietly supplies relevant context at the start of later tasks.

Termyte is not yet a self-correcting system. Outcomes can be recorded and inspected, but automatic attribution from an injected memory to a later task result is incomplete.

## Install

```bash
npm install -g termyte
termyte init
```

`termyte init` lets you select Claude Code and/or Codex and choose one synthesis source:

- existing Claude Code or Codex authentication;
- an OpenAI-compatible API key from `TERMYTE_LLM_API_KEY`;
- capture-only mode.

Termyte stores its configuration and SQLite database under `~/.termyte`. Hooks run silently during normal agent work. Open `termyte viewer` to inspect sessions, episodes, evidence, memories, context decisions, outcomes, feedback, and runtime failures.

## Public commands

```text
termyte init
termyte viewer [--no-open]
termyte doctor [--json]
termyte uninstall
termyte help
```

## Runtime

```text
agent event
  -> redaction and trace persistence
  -> episode and evidence recording
  -> durable background jobs
  -> observations and memories with provenance
  -> task-scoped context packet
  -> Claude Code or Codex prompt context
```

Context retrieval is repository-scoped, lifecycle-aware, budgeted, and allowed to return no memory. The foreground hook uses FTS-only retrieval so it never downloads or initializes an embedding model while the agent is waiting. Local embeddings and durable synthesis run in the background.

## Current boundaries

- integrations are limited to Claude Code and Codex;
- redaction is heuristic, not comprehensive;
- ranking has deterministic bounds but is not calibrated on a public coding-agent corpus;
- explicit outcome and memory feedback exist, but automatic outcome attribution is incomplete;
- component and packed-install tests pass; a controlled live-agent product-value evaluation is still required.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
