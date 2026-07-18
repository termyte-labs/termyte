# Termyte

Termyte is a local execution and continuity layer for coding agents. It records agent execution, preserves evidence, maintains authoritative task state, and supplies relevant state and experience to later sessions.

Termyte closes the local context loop: delivered memories are linked to task episodes, evidence, outcomes, item-level effects, and bounded feedback that can influence later admission and ranking.

## Install

```bash
npm install -g termyte
termyte init
```

`termyte init` lets you select Claude Code, Codex, and/or OpenCode and choose one synthesis source:

- existing Claude Code, Codex, or OpenCode authentication;
- an OpenAI-compatible API key from `TERMYTE_LLM_API_KEY`;
- capture-only mode.

Termyte stores its configuration and SQLite database under `~/.termyte`. Hooks run silently during normal agent work. Open `termyte viewer` to inspect sessions, episodes, evidence, memories, context decisions, outcomes, feedback, and runtime failures.

## Public commands

```text
termyte init
termyte viewer [--no-open]
termyte doctor [--json]
termyte task <create|show|add-step|verify-step|checkpoint|resume|handoff> [options]
termyte uninstall
termyte help
```

## Runtime

```text
agent event
  -> redaction and idempotent trace persistence
  -> deterministic prompts, tools, commands, and file-change projections
  -> episode and evidence recording
  -> durable background jobs
  -> observations and memories with provenance
  -> authoritative task state, then historical context
  -> agent prompt context or explicit resume/handoff packet
  -> episode outcome and item-level context effect
  -> bounded feedback into lifecycle and ranking
```

Task state covers requirements, ordered steps, decisions, failures, verification evidence, transitions, checkpoints, and immutable handoffs. Step verification requires passing evidence and explicit user authority; optimistic version checks reject stale writes. Historical retrieval remains repository-scoped, lifecycle-aware, budgeted, and allowed to abstain.

### Background synthesis

In agent mode, `termyte-worker` reuses an authenticated coding-agent CLI as a one-shot, non-interactive synthesis provider. Claude Code runs with `claude -p`, Codex with `codex exec`, and OpenCode with `opencode run --format json`. Termyte sends redacted trace-derived prompts to the selected provider, validates its structured response, stores observations with trace provenance, and then consolidates those observations into memories.

This happens outside the foreground capture hook. API mode uses an OpenAI-compatible endpoint instead; capture-only mode stores events without forming observations or memories.

## Current boundaries

- capture and non-interactive synthesis support Claude Code, Codex, and OpenCode; OpenCode automatic context injection is not supported;
- OpenCode capture is installed through a generated local plugin and has not yet completed a published live cross-agent acceptance trial;
- redaction is heuristic, not comprehensive;
- ranking has deterministic bounds but is not calibrated on a public coding-agent corpus;
- deterministic attribution is not causal proof that context produced an outcome;
- inferred `unused` is effect-only, and inferred harm is never applied without explicit harmful/correction feedback;
- component, migration, closed-loop, and packed-install tests pass; controlled paired agent trials are still required before claiming product-value improvements.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run verify
```
