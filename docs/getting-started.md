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

- `termyte search <query>` to find relevant memory
- `termyte context` to build a context block for the current task
- `termyte memory <id>` to inspect one memory row
- `termyte explain <id>` to see provenance, edges, and feedback

## Configuration

The most important environment variables are:

- `TERMYTE_DB` - SQLite database path
- `TERMYTE_LLM_BASE_URL` - OpenAI-compatible chat endpoint
- `TERMYTE_LLM_API_KEY` - chat endpoint credential
- `TERMYTE_LLM_MODEL` - observation and consolidation model
- `TERMYTE_EMBED_MODEL_LOCAL` - local embedding model
- `TERMYTE_AUTO_WORKER` - set to `0` to disable detached worker startup

## Practical Rule

Use Termyte to capture what happened, not as a substitute for judgment.
Retrieved memories are context, not ground truth.

