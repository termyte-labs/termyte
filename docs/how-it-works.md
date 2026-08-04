# How Termyte works

Termyte has four local runtime paths: capture, reflection, session briefing, and prompt application.

```text
Codex or Claude Code hooks
  -> normalize and redact raw events
  -> store traces in local SQLite
  -> enqueue reflection after a meaningful session
  -> detached worker creates one evidence-linked experience
  -> new sessions receive a broad project briefing
  -> each prompt receives only relevant experience and evidence
```

## Capture

Both adapters normalize prompts, tools, outputs, files, responses, and timestamps into the same trace shape. Sessions use a canonical repository identity derived from the normalized Git origin, or the repository directory when no origin exists. Inserts are idempotent and common secrets are redacted before storage.

Termyte ignores its own internal agent calls through `TERMYTE_INTERNAL_SYNTHESIS`, preventing recursive capture.

## Reflection

A session is meaningful when it contains a user prompt and either tool activity or a final response. Completion creates one durable reflection job per source session. The hook returns immediately and starts a detached worker.

The worker claims jobs with a lease, retries failures up to three times, and creates at most one experience per source session. The reflection prompt requires structured JSON, evidence-only claims, and explicit worked, failed, corrected, reusable, and unfinished information. Invalid model output does not become experience.

## Project briefing

Every `SessionStart` receives a deterministic briefing containing:

- package description, scripts, dependencies, README introduction, and top-level structure;
- current Git branch, commit, staged, unstaged, untracked, and conflict state;
- recent requests, results, unfinished sessions, and touched files;
- compact experience records from earlier repository sessions.

The briefing uses observed repository data. It does not claim symbol, AST, or semantic code understanding.

## Prompt application

Every `UserPromptSubmit` sends the current request, project briefing, and compact all-session experience catalogue to the configured coding agent. The agent returns up to four relevant experience IDs. Termyte then loads the complete selected records and their source evidence, packs them to the prompt budget, and injects them.

Selection has a short timeout. If the agent fails, Termyte uses local lexical relevance. If nothing is relevant, it injects nothing. Context failure never blocks the coding agent.

## Storage

SQLite stores sessions, raw traces, legacy handoffs, experiences, and reflection jobs. Experiences have a unique source session and retain their evidence payload. Reflection jobs keep attempts, retry timing, lease expiry, and errors so interruption does not silently lose work.

## Current boundaries

Termyte has no embeddings, vector search, model training, cloud sync, dashboard, team permissions, or external work integrations. Token limits use a conservative character estimate rather than a model-specific tokenizer. Local lexical fallback is less precise than agent selection.
