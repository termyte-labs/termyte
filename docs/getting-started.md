# Getting Started

## Install

Install Termyte and wire one supported agent:

```bash
termyte install <platform>
```

Supported platforms include Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Windsurf, and MCP-only targets.

## Verify

Run the local health checks:

```bash
termyte smoke
termyte doctor
termyte stats
```

`termyte smoke` is the quickest end-to-end proof. It checks queue health, writes a portable shared context file, and can optionally invoke a live agent adapter.

## Use

- `termyte search <query>` to find relevant experience
- `termyte context` to build compact, task-scoped experience cards
- `termyte memory <id>` to expand one memory card
- `termyte explain <id>` to see provenance, edges, and feedback

Context cards include stable memory IDs and an explicit `termyte memory <id>` detail path. Termyte keeps the first packet small; request deeper provenance only when the card is relevant.

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
