# CLI reference

The `termyte` binary has seven subcommands. Every subcommand takes `--json` where it makes sense to produce machine-readable output.

```
termyte <command> [args]
```

## `termyte search <query>`

Hybrid FTS5 + vector search across the memory corpus.

```bash
termyte search "how does authentication work"
termyte search "JWT" --repo github.com/termyte-labs/termyte
termyte search "rate limit" --files src/synth/rate-limit.ts,src/synth/spend.ts --limit 5
termyte search "JWT" --json
```

| Flag | Description |
|---|---|
| `--repo <repo_id>` | Restrict to a specific repository. |
| `--limit <n>` | Max results to return (default 20). |
| `--files <a,b,c>` | Comma-separated list of files in scope. Triggers file-aware boosting. |
| `--json` | Emit machine-readable JSON instead of markdown. |

If no results are found, prints `(no results)` and exits 0.

## `termyte context`

Render a markdown context block suitable for pasting into an agent's prompt. The block includes the top memories matching the query (or the most recent memories if no query), the last 20 observations, and the most recent summary for the repo.

```bash
termyte context
termyte context --query "deployment" --files infra/
termyte context --repo github.com/me/proj --limit 30
```

| Flag | Description |
|---|---|
| `--query <q>` | Use hybrid search instead of recent memories. |
| `--repo <repo_id>` | Restrict to a specific repository. |
| `--limit <n>` | Max memories to include (default 50). |
| `--files <a,b,c>` | Comma-separated list of files in scope. |

Output is a single markdown document. Pipe into your agent's prompt or save to a file.

## `termyte memories`

List the most recent memories. Useful for browsing the corpus.

```bash
termyte memories
termyte memories --repo github.com/me/proj --limit 30
termyte memories --type warning
```

| Flag | Description |
|---|---|
| `--repo <repo_id>` | Restrict to a specific repository. |
| `--limit <n>` | Max memories to list (default 50). |
| `--type <t>` | Filter by type: `bugfix`, `convention`, `warning`, `procedure`, or `fact`. |

## `termyte memory <id>`

Show one memory by id. `--json` emits the full row.

```bash
termyte memory 42
termyte memory 42 --json
```

## `termyte trace <id>`

Show one raw trace by id. Includes the JSON-encoded tool input and output, and the `ingest_*` operational columns. `--json` is the most useful form for debugging adapters.

```bash
termyte trace 100
termyte trace 100 --json
```

## `termyte session <id>` / `termyte sessions`

Show one session by id, or list the most recent sessions.

```bash
termyte session abc-123
termyte session abc-123 --json
termyte sessions --limit 20
```

## `termyte install <platform>`

Wire termyte into a specific agent. See [Agent setup](./agents.md) for the full list and per-agent details.

```bash
termyte install claude-code
termyte install codex
termyte install opencode
termyte install cursor
termyte install gemini-cli
termyte install windsurf
termyte install mcp:copilot-cli
termyte install mcp:antigravity
termyte install mcp:goose
termyte install mcp:roo-code
termyte install mcp:warp

# Project-level install (writes to ./.claude/settings.json instead of ~/.claude/settings.json)
termyte install claude-code --target project
```

The installer always backs up any pre-existing config file before overwriting. The backup is named `<original>.bak.<timestamp>`.

## `termyte synth`

Background synthesis one-shot. Reads unprocessed traces, calls the configured `AgentAdapter`, writes observations back, and marks the traces processed.

```bash
# Default: auto-detect adapter, default budget caps
termyte synth

# Pin a specific adapter
termyte synth --adapter claude-code

# Restrict to a single session or repo
termyte synth --session <session_id>
termyte synth --repo <repo_id>

# Preview what would be sent without writing
termyte synth --dry-run

# Override the default batch and budget
termyte synth --batch-size 25 --max-budget-usd 0.10
```

| Flag | Description |
|---|---|
| `--adapter <id>` | Override the auto-detected synthesis adapter. |
| `--session <id>` | Only process traces from this session. |
| `--repo <id>` | Only process traces from this repo. |
| `--dry-run` | Print what would be sent; do not write or mark anything. |
| `--batch-size <n>` | Max traces per batch (default 50). |
| `--max-budget-usd <n>` | Per-invocation spend cap. |
| `--max-batches <n>` | Max batches per invocation (default 5). |
| `--json` | Emit machine-readable JSON. |

The synth process is bounded by `TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS` and `TERMYTE_SYNTH_DAILY_BUDGET_USD`. See [Configuration](./configuration.md).

## `termyte stats`

Local stats. Never phoned home.

```bash
termyte stats
```

Sample output:

```
db:                  ./termyte.db
embedding model:     nomic-embed (local ONNX)
synthesis adapter:   claude-code
unprocessed traces:  12
recent sessions:     3

today (2026-06-28):
  invocations:    3
  input tokens:   4,231
  output tokens:  1,108
  est. cost USD:   $0.0120
  daily budget:    $0.50 / 50 invocations (6% used)
```

## `termyte mcp`

Run the stdio MCP server. The server speaks JSON-RPC 2.0 and exposes five tools. See [MCP server](./mcp.md) for the full protocol details.

```bash
termyte mcp
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Operational error (DB error, adapter failure, etc.). The error message is on stderr. |
| `2` | Invalid usage (missing argument, unknown command, unknown platform). |
