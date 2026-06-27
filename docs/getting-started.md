# Getting started

This page gets you from zero to a working memory corpus in about five minutes. By the end you'll have termyte installed, hooked into your coding agent, and have run your first search.

## Prerequisites

- **Node.js >= 20** (verify with `node -v`).
- A C/C++ toolchain. `better-sqlite3` is a native module; on most systems `npm install` will fetch a prebuilt binary, but on minimal containers you may need `build-essential` / `python` / Xcode CLT.
- One of the supported coding agents: Claude Code, Codex, OpenCode, Cursor, Gemini CLI, or Windsurf. The agent must already be installed and on `PATH` (or its binary location known to termyte).

## Step 1 — Install

```bash
npm install -g termyte
```

This puts three binaries on your `PATH`:

- `termyte` — the human-facing CLI (`search`, `context`, `install`, `synth`, `stats`, `mcp`).
- `termyte-hook` — the agent hook driver. Reads a JSON payload on stdin, normalizes it, writes a trace to SQLite.
- `termyte-worker` — the legacy in-process observer. Superseded by `termyte synth`; kept for compatibility.

Verify with `termyte help`.

## Step 2 — Wire termyte into your agent

Run one command. The supported values are listed under `Supported install platforms:` in `termyte help`.

```bash
# Pick whichever you actually use
termyte install claude-code
termyte install codex
termyte install opencode
termyte install cursor
termyte install gemini-cli
termyte install windsurf

# MCP-only IDEs (no hook capture, but you still get search via MCP)
termyte install mcp:copilot-cli
termyte install mcp:antigravity
termyte install mcp:goose
termyte install mcp:roo-code
termyte install mcp:warp
```

The installer writes the appropriate hook config (`~/.claude/settings.json`, `~/.codex/hooks.json`, etc.) and backs up any pre-existing file. It does **not** modify your agent's other settings.

For OpenCode, the installer copies a small plugin into `~/.config/opencode/plugins/` and registers it in `~/.config/opencode/opencode.json`.

For MCP-only IDEs, the installer writes an `mcpServers` (or `servers`) entry that points at `termyte mcp` so the IDE can call the search tools.

## Step 3 — Use your agent normally

Every tool call, file read, file write, shell command, and final response is captured. Traces accumulate in `./termyte.db` (or wherever `TERMYTE_DB` points). Nothing leaves your machine.

## Step 4 — Synthesize memories

Trace capture is the cheap half. Synthesis is the half that turns a pile of tool calls into a memory you can search. It runs in the background and reuses the LLM plan you're already paying for.

```bash
# One-shot: process every unprocessed trace in the DB
termyte synth

# Restrict to a specific session or repo
termyte synth --session <session_id>
termyte synth --repo <repo_id>

# Preview without writing anything
termyte synth --dry-run

# Pin a specific synthesis adapter (default: auto-detect)
termyte synth --adapter claude-code
```

Synthesis is bounded by default. See [Configuration](./configuration.md) for the budget caps.

## Step 5 — Search

```bash
# Free-text search (hybrid FTS5 + vector)
termyte search "how does authentication work"

# Limit by repo or by files in scope
termyte search "JWT" --repo github.com/termyte-labs/termyte
termyte search "rate limit" --files src/synth/rate-limit.ts,src/synth/spend.ts

# Get machine-readable results
termyte search "JWT" --json

# Render a markdown context block for an agent prompt
termyte context --query "deployment" --files infra/
```

The `context` subcommand is the one to wire into your agent's "before each task" prompt — it renders a tight markdown summary of the most relevant memories for the current query and file scope.

## Step 6 — Watch the spend

```bash
termyte stats
```

This is local-only (never phoned home) and shows:

- The configured DB path and embedding model.
- The synthesis adapter that would be used next.
- How many unprocessed traces are waiting.
- Today's invocations, input/output tokens, and estimated USD cost.
- The current day-spend as a percentage of the configured caps.

## Where next?

- [Concepts](./concepts.md) — the `traces → observations → memories` data model.
- [Configuration](./configuration.md) — every env var.
- [Architecture](./architecture.md) — how the pieces fit together under the hood.
- [Agent setup](./agents.md) — per-agent install details.
- [MCP server](./mcp.md) — if you're using an MCP-only IDE.
- [Adapter development](./adapters.md) — if you're writing a new platform adapter.
- [Troubleshooting](./troubleshooting.md) — if something didn't work.
