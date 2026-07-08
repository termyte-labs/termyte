# Termyte

Termyte is the best persistent memory layer for coding agents.
It captures agent work as traces, turns those traces into observations and memories, and returns relevant context through CLI, MCP, hooks, and a local viewer.

## What it does

- captures normalized agent events into SQLite traces
- redacts obvious secrets before persistence and LLM calls
- runs a durable queue with leases, retries, backoff, and dead letters
- derives observations and memories from traces
- retrieves with FTS5, local embeddings, sqlite-vec when available, and reciprocal-rank fusion
- records context injections and explicit feedback
- exposes `termyte search`, `context`, `memory`, `explain`, `doctor`, `stats`, `smoke`, `mcp`, and `viewer`

## What works today

- adapters for Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Windsurf, and raw payloads
- immutable trace capture in SQLite
- durable jobs with worker supervision
- trace to observation to memory processing
- typed retrieval for trace, observation, memory, summary, and episode documents
- context injection tracking and explainability
- local diagnostics and benchmarking

## What does not work yet

- it is not self-correcting
- outcome attribution is not closed end to end
- correction text is not verified against repository evidence
- redaction is heuristic, not comprehensive
- ranking calibration is still incomplete
- OpenCode still writes a shared context block instead of a true live memory injection path

## How to use it

1. Install a supported integration with `termyte install <platform>`.
2. Run `termyte smoke` to confirm hooks, queue health, and shared context export.
3. Use `termyte search` or `termyte context` to pull relevant memory back into the current task.
4. Use `termyte explain memory:<id>` when you want the provenance trail.
5. Use `termyte doctor` and `termyte stats` for local health checks.

## Comparisons

| Product | What it is | Where it differs from Termyte |
|---|---|---|
| Termyte | Local-first memory layer for coding agents | SQLite-backed, provenance-heavy, focused on capture, retrieval, and operator visibility |
| mem0 | Memory platform and OSS memory layer for general agents | Broader platform/API shape, managed and self-hosted modes, less tied to local agent hooks |
| agentmemory | Large OSS memory engine with many integrations and benchmarks | Much broader surface area, more opinionated platform and docs stack, heavier footprint |
| claude-mem | Claude Code-first persistent memory system | More Claude-specific and workflow-heavy, with a larger hook and server surface |

Termyte is narrower than the others on purpose. It is trying to be a local, inspectable memory layer for coding agents, not a general memory platform.

## Docs

- [Public docs](docs/README.md)
- [How it works](docs/how-it-works.md)
- [Comparisons](docs/comparisons.md)
- [Limitations](docs/limitations.md)
- [LLM index](docs/llms.txt)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The built CLI lives under `dist/cli/`.
