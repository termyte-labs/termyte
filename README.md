# Termyte

Termyte is a local experience layer for coding agents. It records agent execution, preserves evidence, derives repository-specific experience, and quietly supplies relevant context at the start of later tasks.

Termyte closes the local context loop: delivered memories are linked to task episodes, evidence, outcomes, item-level effects, and bounded feedback that can influence later admission and ranking.

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
  -> episode outcome and item-level context effect
  -> bounded feedback into lifecycle and ranking
```

Context retrieval is repository-scoped, lifecycle-aware, budgeted, and allowed to abstain. Packets contain compact experience cards with stable memory and injection IDs. Attribution runs durably after an episode outcome: explicit feedback is decisive, conservative evidence can infer low-confidence help, and ambiguity remains `unknown`. The foreground hook uses FTS-only retrieval, so it never downloads or initializes an embedding model while the agent is waiting.

## Current boundaries

- integrations are limited to Claude Code and Codex;
- redaction is heuristic, not comprehensive;
- ranking has deterministic bounds but is not calibrated on a public coding-agent corpus;
- deterministic attribution is not causal proof that context produced an outcome;
- inferred `unused` is effect-only, and inferred harm is never applied without explicit harmful/correction feedback;
- component, closed-loop, and packed-install tests pass; controlled paired Claude Code/Codex trials are still required before claiming product-value improvements.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run verify
```
