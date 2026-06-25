# Termyte

A memory layer for coding agents. Port of claude-mem's core architecture
(trace → observer → memory → retrieval) stripped of every feature that
isn't load-bearing for an MVP.

## Architecture

```
   Agent Event
     -> Platform Adapter (claude-code | codex | opencode | cursor)
     -> Normalized trace (in-memory)
     -> Ingestor (raw trace -> SQLite)
     -> Observer (LLM: traces -> XML -> memory)
     -> Memory (SQLite)
     -> Retrieval (FTS + vector + RRF)
```

The five stages are strict: nothing reaches `memories` that didn't
come from the observer; nothing reaches the LLM that didn't come from
`traces`. The agent never sees the database directly.

## Storage

Four tables. Nothing else.

```sql
sessions(id, session_id, project, started_at, ended_at)
traces(id, session_id, timestamp, event_type, tool_name, tool_input,
       tool_output, files_read, files_modified, user_prompt,
       final_response, processed_at)
memories(id, session_id, type, title, subtitle, facts, narrative,
        concepts, files_read, files_modified, created_at, embedding)
summaries(id, session_id, request, investigated, learned, completed,
         next_steps, notes, created_at)
```

`traces.processed_at` is operational state: the observer sets it after
generating memories. This makes the observer crash-safe — a process
that dies mid-batch leaves the trace unprocessed and the next pass
picks it up.

`memories.embedding` is a BLOB of raw Float32 bytes; one cosine
similarity pass over in-memory vectors. No external vector DB.

A FTS5 mirror of `memories` is created alongside the tables and kept
in sync via triggers.

## CLI

```bash
# Hook entry: reads JSON from stdin, ingests, waits for the observer
# to drain, exits. The agent's hook system calls this.
termyte-hook <claude-code|codex|opencode|cursor>

# Standalone observer: processes unprocessed traces and exits.
termyte-worker [--once]

# Search and context rendering for humans / future agent prompts.
termyte search <query> [--project p] [--limit n] [--json]
termyte context [--project p] [--query q] [--limit n]
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `TERMYTE_DB` | `./termyte.db` | SQLite file path (use `:memory:` for tests) |
| `TERMYTE_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `TERMYTE_LLM_API_KEY` | (none) | LLM API key — required for the observer |
| `TERMYTE_LLM_MODEL` | `gpt-4o-mini` | Model used for observation extraction |
| `TERMYTE_EMBED_BASE_URL` | same as LLM | Embeddings endpoint base URL |
| `TERMYTE_EMBED_API_KEY` | falls back to `OPENAI_API_KEY` | Embeddings API key |
| `TERMYTE_EMBED_MODEL` | `text-embedding-3-small` | Embeddings model |
| `TERMYTE_EMBED_DIMENSIONS` | `1536` | Embedding vector size |

The LLM and embeddings endpoints can point at any OpenAI-compatible
service: OpenAI, Ollama, LM Studio, vLLM, etc. If no embedding API
is configured, semantic search is disabled and `termyte search`
degrades to FTS-only.

## Hook wiring (Claude Code example)

```json
{
  "hooks": {
    "SessionStart":     [{ "type": "command", "command": "termyte-hook claude-code" }],
    "UserPromptSubmit": [{ "type": "command", "command": "termyte-hook claude-code" }],
    "PostToolUse":      [{ "type": "command", "command": "termyte-hook claude-code" }],
    "Stop":             [{ "type": "command", "command": "termyte-hook claude-code" }]
  }
}
```

Other agents have equivalent hook configurations. The payload shape
is whatever the agent sends on stdin; the adapter normalizes it.

## Tests

```bash
npm install
npm test
```

The test suite uses vitest with an in-memory SQLite store. The
observer tests use a `MockLLM` that returns canned XML; the retrieval
tests use a deterministic `FixedEmbeddings` provider. No network
calls, no live LLM, no live embeddings.

## What this is not

This MVP does not include — by design — any of:

- Confidence scoring or Bayesian updates
- Memory freshness or decay
- Self-correcting memory, verification, or feedback loops
- Memory consolidation workers
- Multi-agent coordination
- Chroma / vector DB sync
- Team/project multi-tenancy beyond a single `project` column
- Authentication, dashboards, notifications
- Server-side multi-tenant runtime

The architecture supports adding these later. They are out of scope
per the spec.
