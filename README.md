<div align="center">

# Termyte

**Local-first memory layer for AI coding agents.**

Persistent context across sessions. Searchable, file-aware, and 100% local. Use the LLM plan you already pay for — or none at all.

[![npm version](https://img.shields.io/npm/v/termyte.svg)](https://www.npmjs.com/package/termyte)
[![npm downloads](https://img.shields.io/npm/dm/termyte.svg)](https://www.npmjs.com/package/termyte)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-155%20passing-brightgreen)](https://github.com/termyte-labs/termyte)

</div>

---

## What is Termyte?

Termyte is a **memory layer for AI coding agents**. It captures every tool call, file read, file write, shell command, and final response from your coding agent, stores them in a local SQLite database, and synthesizes them into searchable, durable memories. The next time you (or the agent) open the project, Termyte surfaces the relevant memories as context — so the agent doesn't have to rediscover what you already know.

Termyte runs **entirely on your machine**. No API key is required. No data leaves your computer. The only outbound call is when you opt-in to having your *existing* coding agent (Claude Code, Codex, OpenCode, Gemini) synthesize the memory in the background — and that call goes to the same plan you're already paying for, not a separate service.

**Inspired by [claude-mem](https://github.com/thedotmack/claude-mem).** Termyte is a stripped-down, cross-agent, local-first port of claude-mem's core architecture.

---

## Quickstart (60 seconds)

```bash
# 1. Install
npm install -g termyte

# 2. Wire it into your agent (one command)
termyte install claude-code
# or: termyte install codex | cursor | gemini-cli | windsurf | opencode

# 3. Use your agent normally. Memories accumulate automatically.

# 4. Search what the agent knows
termyte search "how does authentication work"
```

That's it. There's no server to start, no API key to configure, no cloud account to create.

---

## Why use Termyte?

Every coding agent — Claude Code, Codex, OpenCode, Cursor, Gemini, Windsurf, Copilot — starts each session with a blank slate. It re-reads your codebase, re-asks the same clarifying questions, and re-makes the same architectural mistakes. Termyte fixes this.

- **Cross-session memory.** Memories survive across agent sessions, across reboots, across machine moves (the SQLite file is portable).
- **Cross-agent memory.** The same memory corpus is queryable from Claude Code, Codex, OpenCode, Cursor, Gemini, Windsurf, and any MCP-compatible agent.
- **Local-first.** No cloud, no SaaS, no telemetry. The embeddings model runs locally via ONNX (Transformers.js). The DB is a single SQLite file.
- **Hooks-based capture.** Zero code changes to the agent. Termyte hooks into the agent's existing hook protocol (`PostToolUse`, `SessionStart`, `Stop`, etc.).
- **Async synthesis.** Memory generation happens in the background, never blocking the agent's response. The synthesis uses the agent's own LLM plan — not a separate API call.
- **Searchable.** Hybrid FTS5 + vector search with file-aware boosting. Find the right memory by keyword, semantic similarity, or both.
- **Standard interfaces.** Provides an MCP server so any MCP-compatible IDE (Copilot CLI, Antigravity, Goose, Roo, Warp) can search the corpus via tools.

---

## How it works

```
                          ┌─────────────────────────────────┐
                          │  Your coding agent              │
                          │  (Claude Code, Codex, etc.)    │
                          └────────────┬────────────────────┘
                                       │ hook events
                                       ▼
                          ┌─────────────────────────────────┐
                          │  termyte-hook                   │
                          │  - normalize via platform       │
                          │    adapter                      │
                          │  - write to SQLite traces       │
                          │  - fire-and-forget              │
                          └────────────┬────────────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────────────┐
                          │  Local SQLite                   │
                          │  - sessions                     │
                          │  - traces  (raw events)         │
                          │  - observations                │
                          │  - memories   ←── you search    │
                          │  - summaries                    │
                          └────────────┬────────────────────┘
                                       │ background
                                       ▼
                          ┌─────────────────────────────────┐
                          │  termyte-synth                  │
                          │  - groups unprocessed traces    │
                          │  - asks the agent's LLM to     │
                          │    synthesize observations     │
                          │  - writes back to SQLite       │
                          │  - daily budget cap (50/day    │
                          │    default, configurable)      │
                          └─────────────────────────────────┘
```

Three components:

1. **termyte-hook** — runs on every agent event. Captures the raw event into SQLite, optionally runs a fast event handler (e.g. inject memories as `additionalContext` for a `PreToolUse Read`).
2. **termyte-synth** — background one-shot synthesis. Reads unprocessed traces, hands them to the agent's LLM (or a local model), writes observations + memories back to SQLite.
3. **termyte (CLI)** — search, context, stats, install. The human-facing surface.

---

## Supported agents

| Agent | Hook | Synthesis | Notes |
|---|---|---|---|
| **Claude Code** | ✅ | ✅ | Most-tested adapter. `SessionStart` → context, `PostToolUse` → trace, `Stop` → synth. |
| **Codex** (OpenAI) | ✅ | ✅ | Uses `codex exec --json --output-schema` for structured output. |
| **OpenCode** | ✅ | ✅ | HTTP-first via `opencode serve`, falls back to CLI. |
| **Cursor** | ✅ | ⚠️ manual | Hooks capture traces. Cursor can't trigger agents, so `termyte-synth` must be scheduled via cron / OS scheduler. |
| **Gemini CLI** | ✅ | ✅ | Free tier rate-limited to 50/min. |
| **Windsurf** | ✅ | ⚠️ manual | No synthesis CLI; trace capture only. |
| **Any MCP client** | n/a | n/a | Use the MCP server to search memories from any tool. |

---

## CLI

```bash
# Install
termyte install <claude-code|codex|opencode|cursor|gemini-cli|windsurf|opencode|mcp:copilot-cli|mcp:antigravity|mcp:goose|mcp:roo-code|mcp:warp>

# Search
termyte search "authentication" [--repo r] [--limit n] [--json]
termyte search "JWT" --files src/auth.ts,src/middleware.ts

# Inject as agent context
termyte context [--query q] [--limit n]

# Background synthesis (one-shot)
termyte synth [--session <id>] [--adapter claude-code] [--dry-run] [--batch-size 25]

# Stats (local — never phoned home)
termyte stats

# MCP stdio server (for MCP-compatible IDEs)
termyte mcp

# Help
termyte help
```

---

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `TERMYTE_DB` | `./termyte.db` | SQLite file path (use `:memory:` for tests) |
| `TERMYTE_EMBED_MODEL_LOCAL` | `nomic-embed` | Local embedding model. `nomic-embed` (768d) or `bge-small` (384d). |
| `TERMYTE_SYNTH_ADAPTER` | auto-detect | Pin the synthesis adapter: `claude-code`, `codex`, `opencode`, `gemini-cli`. |
| `TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS` | `50` | Max synthesis invocations per day. |
| `TERMYTE_SYNTH_DAILY_BUDGET_USD` | `0.50` | Max estimated USD spend per day. |
| `TERMYTE_SYNTH_TIMEOUT_MS` | `300000` | Per-batch synthesis timeout. |
| `OPENAI_API_KEY` | n/a | Used for OpenAI-based synthesis (Codex) or for backwards-compat. |

Termyte is **fully usable without any API key**: the local embedding model handles semantic search, and you can opt to skip synthesis entirely (only ingest traces for later analysis).

---

## Programmatic API

```ts
import { createTermyte, Batcher, ClaudeCodeAdapter, FakeAdapter } from "termyte";

const ty = createTermyte({
  dbPath: "./my-memory.db",
  llm: { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o-mini" },
  embeddings: { model: "nomic-embed" },
});
ty.runner.processRaw("claude-code", rawHookPayload);
const results = await ty.search.search({ query: "JWT", limit: 5 });
ty.close();
```

Or build a custom synthesis pipeline:

```ts
import { Batcher, FakeAdapter, createAdapter, discoverAdapter } from "termyte";

const adapterId = await discoverAdapter(); // finds the first available agent
const adapter = createAdapter(adapterId!);
const batcher = new Batcher(store, adapter);
const result = await batcher.runOnce({ batchSize: 25 });
console.log(`synthesized ${result.observationsWritten} observations`);
```

---

## Architecture decisions

- **No dedicated LLM.** Termyte is a memory layer, not an LLM provider. Synthesis reuses whatever agent you already have running. This means: zero API key configuration for the user, no separate billing, no second copy of your codebase leaving your machine.
- **Local embeddings.** Vector search uses Transformers.js running ONNX models locally. Nomic Embed v1.5 (768d) is the default; BGE Small (384d) is the fallback. No API calls, no rate limits.
- **SQLite + sqlite-vec.** The DB is a single file you can `rsync`, `cp`, or attach to git-lfs. `sqlite-vec` is an optional native extension; the in-memory cosine path is the fallback.
- **Crash-safe.** Every batch is recorded against `processed_at` columns. A `termyte-synth` that crashes mid-batch leaves its traces unprocessed; the next run picks them up.
- **Bounded.** A 50-trace batch cap, a 5-batch-per-run cap, a daily invocation/cost cap, a per-batch timeout. The synthesis cannot eat the user's quota.

---

## Comparison with claude-mem

| | claude-mem | Termyte |
|---|---|---|
| **Targets** | Claude Code only | 7 agents + MCP |
| **LLM** | Dedicated Claude API | Reuses your agent's plan |
| **Storage** | SQLite + Chroma sync | SQLite only (sqlite-vec optional) |
| **Embeddings** | OpenAI API | Local ONNX |
| **Architecture** | 2-layer (trace → memory) | 3-layer (trace → observation → memory) |
| **Hooks** | Claude Code only | Per-agent adapters |
| **Server** | Long-lived daemon | One-shot CLI |
| **Telemetry** | PostHog | None |
| **License** | MIT | MIT |

Termyte is **not a drop-in replacement** for claude-mem — it has fewer features and a smaller test matrix. It's a different trade-off: portable, agent-agnostic, local-first.

---

## Tests

```bash
npm install
npm test
```

155 tests across 20 files. In-memory SQLite, MockLLM, deterministic embeddings. No network calls, no live LLM, no live embeddings. Typecheck passes. `prepublishOnly` runs the full gate before any publish.

---

## Documentation

- [`AGENTS.md`](./AGENTS.md) — codebase-level architecture notes for AI agents working on this project.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to set up dev, file PRs, add a new agent adapter.
- [`SECURITY.md`](./SECURITY.md) — private vulnerability disclosure process.
- [`SUPPORT.md`](./SUPPORT.md) — where to ask questions and how to get help.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — community standards.
- [`llm.txt`](./llm.txt) — project description for LLMs (GEO).
- [`docs/background-memory-generation.md`](./docs/background-memory-generation.md) — design rationale for the agent-as-synthesis-adapter pattern.
- [`docs/background-memory-generation-implementation.md`](./docs/background-memory-generation-implementation.md) — implementation status of the design.
- [`docs/mitigation_plan.md`](./docs/mitigation_plan.md) — performance / reliability / cost mitigations applied.
- [`docs/post-mitigation-rescan.md`](./docs/post-mitigation-rescan.md) — re-scan after the mitigation plan was applied.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Contributing

Issues and PRs welcome. The codebase is small (~3,000 LOC) and the architecture is documented in `AGENTS.md`. New agent adapters go in `src/capture/`; new synthesis adapters go in `src/synth/`. Tests are in `test/` and use vitest with an in-memory SQLite.
