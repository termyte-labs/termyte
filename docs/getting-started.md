# Getting Started

## Install

Install Termyte and connect Claude Code or Codex:

```bash
npm install -g termyte
termyte init
termyte viewer
```

`termyte init` detects Claude Code and Codex, installs the selected hooks, and configures synthesis.

## Verify

Run the local health checks:

```bash
termyte doctor
termyte viewer
```

`termyte doctor` reports database, hook, synthesis, queue, and trace health.

## Use

The Viewer exposes sessions, episodes, context packets, memories, provenance, outcomes, and diagnostics.

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
