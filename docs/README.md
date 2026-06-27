# Termyte documentation

Termyte is a local-first memory layer for AI coding agents. It captures every tool call from your coding agent, stores them in a local SQLite database, and synthesizes them into searchable, durable memories that survive across sessions, agents, and machines.

This site is the user-facing documentation. Internal architecture notes for AI agents working on the codebase live in [`AGENTS.md`](../AGENTS.md).

## Where to start

| If you want to… | Read this |
|---|---|
| Get up and running in 5 minutes | [Getting started](./getting-started.md) |
| Understand the data model (traces → observations → memories) | [Concepts](./concepts.md) |
| See how the pieces fit together | [Architecture](./architecture.md) |
| Configure env vars, budgets, and paths | [Configuration](./configuration.md) |
| Look up a CLI flag or subcommand | [CLI reference](./cli.md) |
| Set up a specific agent (Claude Code, Codex, …) | [Agent setup](./agents.md) |
| Use termyte from an MCP-compatible IDE | [MCP server](./mcp.md) |
| Write a new agent adapter | [Adapter development](./adapters.md) |
| Debug a problem | [Troubleshooting](./troubleshooting.md) |
| See common questions answered | [FAQ](./faq.md) |
| Understand the security posture | [Security model](./security.md) |

## What termyte is (and isn't)

**Termyte is:**

- A memory layer that lives between your coding agent and your codebase.
- Local-first — no cloud, no SaaS, no telemetry. The database is a single SQLite file you can `rsync` or attach to git-lfs.
- Agent-agnostic — works with Claude Code, Codex, OpenCode, Cursor, Gemini CLI, Windsurf, and any MCP-compatible IDE.
- Bounded — daily invocation and cost caps mean the synthesis step can never eat your agent's plan.

**Termyte is not:**

- A replacement for your coding agent. It runs alongside it.
- A hosted service. There is nothing to sign up for.
- An LLM. The synthesis step borrows the LLM plan you're already paying for (Claude Code, Codex, OpenCode, or Gemini CLI). Embeddings run locally via ONNX.
- A drop-in replacement for [claude-mem](https://github.com/thedotmack/claude-mem). Termyte has fewer features and a smaller test matrix; it's a different trade-off (portable, agent-agnostic, local-first). See the comparison table in the [README](../README.md#comparison-with-claude-mem).

## Repository layout

```
docs/             this folder
src/
  core/           shared types (Trace, Observation, Memory, Summary, Session)
  capture/        platform adapters (Claude Code, Codex, OpenCode, …) + Ingestor
  storage/        SQLite wrapper, schema migrations, CRUD
  observer/       legacy in-process LLM observer (deprecated)
  synth/          background synthesis pipeline + agent adapters
  retrieval/      FTS5 + vector + hybrid search
  hooks/          stdin → adapter → ingest driver
  context/        markdown rendering for agent prompts
  cli/            CLI entry points (install, search, context, synth, stats, mcp)
  mcp/            stdio MCP server
  integrations/   per-agent installers and the OpenCode plugin
test/             Vitest suite (mock-llm, in-memory DB, deterministic embeddings)
```

For an internal architecture overview aimed at AI assistants, see [`AGENTS.md`](../AGENTS.md).
