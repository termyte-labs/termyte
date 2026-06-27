# FAQ

## General

**What is termyte?**

A local-first memory layer for AI coding agents. It captures every tool call from your coding agent (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, Windsurf, and any MCP-compatible IDE), stores them in a local SQLite database, and synthesizes them into searchable, durable memories that survive across sessions and agents. See the [README](../README.md) for the one-paragraph pitch.

**How is termyte different from claude-mem?**

Termyte is a stripped-down, cross-agent, local-first port of claude-mem's core architecture. The differences:

- claude-mem targets Claude Code only. Termyte targets 7 agents + MCP.
- claude-mem uses a dedicated Claude API. Termyte reuses the agent's existing plan.
- claude-mem syncs to Chroma. Termyte uses SQLite (with optional sqlite-vec).
- claude-mem's embeddings are OpenAI API. Termyte's are local ONNX.
- claude-mem has a 2-layer pipeline (trace → memory). Termyte has 3 (trace → observation → memory).

The full comparison table is in the [README](../README.md#comparison-with-claude-mem).

**Is termyte free?**

Yes. MIT-licensed. No paid tier, no hosted service, no telemetry.

**Does my data leave my machine?**

No — except for the one outbound call you opt into. Specifically:

- The synthesis step calls the LLM plan you're already paying for (Claude Code, Codex, OpenCode, or Gemini CLI). The same calls your agent already makes. There is no separate billing and no separate copy of your codebase leaving your machine.
- The embeddings model runs locally via ONNX. No embedding payload ever leaves your machine unless you've configured an external embedding API (which termyte does not support out of the box).
- The first run downloads the embedding model from the Hugging Face CDN (~100 MB, cached after).

**Does termyte phone home?**

No. `termyte stats` reads the local database; it does not call out. There is no analytics, no error reporting, no usage ping.

**What's the size of the database?**

It depends on how active the agent is. A typical 30-minute session produces ~50–200 traces, each ~1–10 KB. The DB grows monotonically. Run `sqlite3 termyte.db VACUUM;` periodically if disk space matters.

## Installation

**Do I need to install anything besides termyte?**

You need one of the supported coding agents (Claude Code, Codex, OpenCode, Cursor, Gemini CLI, or Windsurf). For synthesis to work, you also need an agent whose CLI exposes a one-shot prompt mode (Claude Code's `claude -p`, Codex's `codex exec`, OpenCode's `opencode run`, or Gemini CLI's `gemini -p`).

**Can I use termyte with multiple agents at once?**

Yes. The same `termyte.db` is shared. Run `termyte install <agent>` for each agent you use. Memories are tagged with `repo_id` so they're scoped per-project; the search results stay clean even when you mix agents.

**Can I have a separate corpus per project?**

Yes. Set `TERMYTE_DB` to a different path per project. The simplest way is a shell alias or a `direnv` `.envrc` in the project root:

```bash
export TERMYTE_DB="$PWD/.termyte.db"
```

**Does termyte work on Windows / macOS / Linux?**

Yes, all three. `better-sqlite3` ships prebuilt binaries for common platforms; on a minimal Linux container you may need to install a C++ toolchain.

**Does termyte work with Copilot CLI / Antigravity / Goose / Roo / Warp?**

Yes — via the MCP server. Run `termyte install mcp:<ide>` to wire up the MCP `mcpServers` entry. These IDEs don't expose a hook protocol, so they don't get automatic trace capture, but the agent can still call the search tools.

## Usage

**How do I add a new agent adapter?**

See [Adapter development](./adapters.md).

**Can I run synthesis on a schedule?**

Yes. The simplest pattern is a cron job that calls `termyte synth` periodically. The Batcher and the spend guard prevent it from running away:

```cron
*/15 * * * * cd /path/to/project && /usr/local/bin/termyte synth --batch-size 25
```

**How do I know synthesis is working?**

`termyte stats` shows the daily invocation count, token count, and estimated cost. The `recent sessions` count should grow over time.

**Can I skip synthesis entirely?**

Yes. Use the corpus as a raw-trace log and rely on FTS5 keyword search over the trace text. Memory type filtering won't be available because no memories have been created.

**How do I export the corpus?**

The DB is a single SQLite file. To export everything as JSON, you can either:

- Open the DB with the `sqlite3` CLI and run `.dump` for raw SQL, or
- Use the programmatic API:
  ```ts
  import { createTermyte } from "termyte";
  const ty = createTermyte({ dbPath: "./termyte.db", llm: { ... } });
  for (const m of ty.store.getRecentMemories(10_000)) {
    console.log(JSON.stringify(m, memoryReplacer));
  }
  ```

**Can I import an existing corpus from claude-mem?**

Not directly. The two schemas differ (claude-mem has Chroma + a different SQLite layout). You can write a one-off migration that copies the rows you want into termyte's schema — see [Concepts](./concepts.md) for the target shape.

## Costs and quotas

**How much does synthesis cost?**

Depends on your plan. The default daily cap is $0.50 USD and 50 invocations. `termyte stats` shows today's spend as a percentage of the cap. If you want to raise or lower the cap, see [Configuration](./configuration.md).

**Can synthesis get expensive accidentally?**

No. The daily caps and per-batch timeouts are hard limits. A misconfigured cron will stop being served once the cap is hit, not eat the user's plan.

**Does termyte charge anything?**

No. The only cost is the LLM API call that the synthesis step makes, billed by the agent's plan, not by termyte.

## Privacy

**Can I see exactly what termyte stored?**

Yes. Every row in the `traces` table is a verbatim copy of an agent event after platform normalization. Use `termyte trace <id> --json` to see one row. To see everything:

```bash
sqlite3 termyte.db "SELECT id, session_id, event_type, tool_name, user_prompt, files_read FROM traces ORDER BY id DESC LIMIT 20;"
```

**Can I redact sensitive tool input/output?**

Not in the current release. Traces store the full JSON of `tool_input` and `tool_output` for debuggability. If a tool's output contains a secret, the secret is in your local DB. The DB is local-only and never leaves your machine, but treat the file as sensitive.

**Can I opt out of certain tools being captured?**

Not at the global level today. At the per-hook level, the agent itself can suppress its own hook output (Claude Code, for example, lets hooks return `{continue: false, suppressOutput: true}`). The trace is still written — only the agent's response is suppressed.

## Compatibility

**Which Node versions are supported?**

Node 20 and above. The `engines` field in `package.json` enforces this.

**Does termyte work with Docker / devcontainers?**

Yes. The MCP server uses stdio, which works inside a container. The synthesis subprocess may not work if the agent's CLI isn't installed in the container — set `TERMYTE_SYNTH_ADAPTER=fake` (or the equivalent for your test) to skip synthesis in tests.

**Does termyte work with git worktrees?**

Yes. `repo_id` is auto-detected from the working directory. Two worktrees of the same repo will share `repo_id` and the same memories.

**Does termyte support multi-root workspaces (VS Code)?**

Partially. Each worktree has its own `cwd`; the hook driver picks the first one. The memory corpus is shared, so search results are repo-scoped via `repo_id`. If you have multiple repos in a multi-root workspace, each gets its own memories.

## What's next?

- [Concepts](./concepts.md) — the data model.
- [Architecture](./architecture.md) — how the pieces fit together.
- [Configuration](./configuration.md) — every env var.
- [Adapter development](./adapters.md) — how to extend termyte.
- [Troubleshooting](./troubleshooting.md) — common issues and fixes.
