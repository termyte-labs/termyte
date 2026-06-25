# Termyte MVP Report

## 1. Claude-Mem Architecture Overview

Claude-mem (v13.8.0) is a production-grade memory compression system for
Claude Code. It has been extended to support Codex, Cursor, Gemini CLI,
Windsurf, and OpenClaw.

### Core Pipeline

```
Agent Hook Event
  → Platform Adapter (src/cli/adapters/<platform>.ts)
  → Handler (src/cli/handlers/<event>.ts)
  → Worker HTTP POST (fire-and-forget)
  → Pending Queue (pending_messages table)
  → SDK Agent (Claude Agent SDK → LLM)
  → XML Parser (src/sdk/parser.ts → parseAgentXml)
  → Observation Storage (observations table)
  → Chroma Sync (src/services/sync/ChromaSync.ts)
  → Search/Retrieval (FTS5 + Chroma + RRF)
  → Context Injection (agent prompt / Cursor rules / OpenCode systemMessage)
```

### Key Files

| Component | File | Lines |
|-----------|------|-------|
| Claude adapter | `src/cli/adapters/claude-code.ts` | ~40 |
| Codex adapter | `src/cli/adapters/codex.ts` | ~120 |
| Cursor adapter | `src/cli/adapters/cursor.ts` | ~55 |
| Gemini adapter | `src/cli/adapters/gemini-cli.ts` | ~80 |
| Windsurf adapter | `src/cli/adapters/windsurf.ts` | ~72 |
| Raw adapter | `src/cli/adapters/raw.ts` | ~27 |
| Session init handler | `src/cli/handlers/session-init.ts` | ~200 |
| Observation handler | `src/cli/handlers/observation.ts` | ~70 |
| SDk prompts | `src/sdk/prompts.ts` | ~400 |
| XML parser | `src/sdk/parser.ts` | ~200 |
| SQLite schema DDL | `src/services/sqlite/schema.sql` | ~250 |
| SessionStore | `src/services/sqlite/SessionStore.ts` | ~2000 |
| SessionSearch (FTS) | `src/services/sqlite/SessionSearch.ts` | ~500 |
| ChromaSync | `src/services/sync/ChromaSync.ts` | ~400 |
| ChromaMcpManager | `src/services/sync/ChromaMcpManager.ts` | ~200 |
| SearchManager | `src/services/worker/SearchManager.ts` | ~500 |
| ContextBuilder | `src/services/context/ContextBuilder.ts` | ~300 |
| SessionManager | `src/services/worker/SessionManager.ts` | ~500 |
| Worker daemon | `src/services/worker-service.ts` | ~2500 |
| MCP server | `src/servers/mcp-server.ts` | ~300 |
| Transcript watcher | `src/services/transcripts/processor.ts` | ~400 |

### How Memory is Created

1. **Hook captures tool use**: Agent fires PostToolUse → hook script sends
   `{tool_name, tool_input, tool_response, cwd, session_id}` to worker.
2. **Worker enqueues**: `SessionManager.queueObservation()` → inserts into
   `pending_messages` table with `status='pending'`.
3. **SDK Agent processes**: Reads pending messages → builds prompt via
   `buildObservationPrompt()` → sends to Claude Agent SDK → model returns XML.
4. **Parser extracts**: `parseAgentXml()` extracts `<observation>` blocks with
   type, title, subtitle, facts, narrative, concepts, files_read,
   files_modified.
5. **Stored**: `SessionStore.insertObservation()` → `observations` table.
   Duplicates detected via `content_hash` (SHA256[:16]).
6. **Synced to Chroma**: `ChromaSync.sync()` indexes narrative and facts as
   separate documents in Chroma collection `cm__<project>`.

### How Traces Are Captured

No separate `traces` table exists. The `pending_messages` table serves as
an ephemeral trace layer. After the SDK agent processes a pending message,
it is deleted (not preserved). The processed output becomes the observation.
Session transcripts (from Codex CLI) are watched by `TranscriptWatcher` and
processed by `TranscriptEventProcessor`, but raw events are not retained.

### How Observations Are Synthesized

The Claude Agent SDK manages the conversation with the model. The prompt
includes:
- System identity ("You are a Termyte observer...")
- Recording focus guidelines
- Skip guidance (skip routine operations)
- Type guidance (6 types)
- Concept guidance (7 concepts)
- Field guidance (facts, files)
- XML output format specification

The model receives each tool's input/output and produces XML. The output
is classified by `output-classifier.ts` and parsed by `parseAgentXml()`.

### How Memories Are Stored

`observations` table (SQLite, WAL mode):
- `id`, `memory_session_id`, `project`, `text`, `type`, `title`, `subtitle`,
  `facts` (JSON), `narrative`, `concepts` (JSON), `files_read` (JSON),
  `files_modified` (JSON), `content_hash`, `created_at_epoch`
- FTS5 virtual table `observations_fts` for full-text search
- UNIQUE(memory_session_id, content_hash) prevents duplicates

Server beta adds `memory_items` in Postgres with `memory_sources` for
provenance tracking.

### How Retrieval Works

Three-layer retrieval:
1. **FTS5**: SQLite FTS5 with porter stemmer. Fast exact/partial keyword
   matches on technical terms.
2. **Chroma**: Vector similarity via `all-MiniLM-L6-v2` embeddings. Multiple
   documents per observation (narrative + each fact). Filtered by project and
   90-day recency window.
3. **RRF combination**: Reciprocal Rank Fusion with k=60 merges both
   result lists.

Search entry points:
- MCP tools: `search`, `timeline`, `get_observations`
- Worker HTTP: `GET /api/search`, `GET /api/timeline`
- Web viewer: `GET /api/observations`

### How Memory Injection Works

Four different injection mechanisms per platform:
- **Claude Code**: `additionalContext` in hook output (real-time, same prompt)
- **Cursor**: Writes to `.cursor/rules/claude-mem-context.mdc` (file-based,
  auto-updated by worker)
- **OpenCode**: `systemMessage` in hook output or `CLAUDE.md` file
- **OpenClaw**: `before_prompt_build` gateway hook

Context generation in `ContextBuilder.ts`:
1. Load config (observation count, session count, token limits)
2. Query recent observations + session summaries
3. Build timeline grouped by date
4. Render agent-formatted output with token budget

### How Session Summaries Work

At session end (`Stop` hook):
1. Worker receives `POST /api/sessions/summarize`
2. SDK Agent builds summary prompt from conversation history
3. Model returns `<summary>` XML block
4. Parser extracts: request, investigated, learned, completed, next_steps,
   notes
5. Stored in `session_summaries` table
6. ChromaSync indexes summary fields for search

### How Agent Integrations Work

Each agent has:
- **Adapter** (`src/cli/adapters/<agent>.ts`): Normalizes raw hook payload
  into `NormalizedHookInput`
- **Handler** (`src/cli/handlers/<event>.ts`): Processes the normalized input
  and communicates with worker
- **Hook configuration**: JSON files dictating which scripts run on which
  events
- **Installer** (`src/services/integrations/<Agent>Installer.ts`): Sets up
  hook scripts, MCP configs, IDE rules files

### Abstractions Between Traces, Observations, and Memories

Claude-mem has **two layers** (not three):
1. **Pending messages**: Raw tool captures → ephemeral queue
2. **Observations**: AI-extracted structured knowledge

There is no separate `traces` table and no separate `memories` table
above observations. The "memory" abstraction is implicit in the
observations. The server beta adds `memory_items` as a third layer but
conceptually it's a normalization of observations, not a distinct layer.

### How Memories Evolve Over Time

No memory evolution. Observations are immutable. New observations may
supplement or contradict old ones, but there is no:
- Memory consolidation or merging
- Confidence updating
- Staleness tracking
- Contradiction detection

The `observation_feedback` table tracks usage signals but does not feed
back into the memory system.

### How Vector Search is Implemented

External ChromaDB process accessed via `chroma-mcp` MCP server over stdio.
- Collection: `cm__<project>` per project
- Multiple documents per observation: `obs_{id}_narrative`, `obs_{id}_text`,
  `obs_{id}_fact_0..N`
- Metadata filtering: `doc_type`, `project`, `merged_into_project`,
  `created_at_epoch`
- Recency filter: 90-day window
- Embedding model: `all-MiniLM-L6-v2` (384 dims) bundled with chroma-mcp

### How Repository Awareness Works

Project name is derived from `cwd`'s last path segment. Proxies for
"repository" but does not:
- Read `.git` metadata
- Hash repo origin
- Track workspace root beyond project name
- Prevent cross-project observation leaks (only project name string match)

### How Provenance is Tracked

- `observations.memory_session_id` FK to `sdk_sessions` → session context
- `observations.content_hash` for dedup
- `observations.generated_by_model` tracks which model extracted it
- `observations.agent_type`/`agent_id` tracks which agent triggered it
- `observations.metadata` extensible JSON field

Server beta adds `memory_sources` table with explicit source tracking
(source_type, legacy_table, legacy_id, source_uri).

---

## 2. Current Termyte Architecture

Termyte (v0.1.0, ~1,200 lines) implements the core pipeline with zero
runtime dependencies beyond `better-sqlite3`.

### Current Architecture

```
Agent Hook Event (stdin JSON)
  → Platform Adapter (src/capture/<agent>.ts)
  → NormalizedEvent
  → Ingestor (writes to traces table)
  → Observer (LLM: traces → XML → memories)
  → Memory (memories table with FTS5 trigger)
  → Retrieval (FTS5 + in-memory cosine sim + RRF)
  → Context (markdown render for CLI)
```

### Current Tables

```sql
sessions(id, session_id, project, started_at, ended_at)
traces(id, session_id, timestamp, event_type, tool_name, tool_input,
       tool_output, files_read, files_modified, user_prompt,
       final_response, processed_at)
memories(id, session_id, type, title, subtitle, facts, narrative,
        concepts, files_read, files_modified, created_at, embedding BLOB)
summaries(id, session_id, request, investigated, learned, completed,
         next_steps, notes, created_at)
memories_fts (FTS5 content-sync mirror of memories)
```

### What Exists

- **4 platform adapters**: Claude Code, Codex, OpenCode, Cursor
- **Ingestor**: NormalizedEvent → trace + session upsert
- **Observer**: In-process or standalone worker, OpenAI-compatible LLM,
  XML parser, memory persistence with embeddings
- **Storage**: SQLite with WAL, FTS5 content-sync triggers
- **Retrieval**: FTS5 + in-memory cosine similarity + RRF (k=60)
- **Context builder**: Markdown renderer for human consumption
- **CLI**: `termyte-hook`, `termyte-worker`, `termyte search`, `termyte context`
- **Tests**: 38 vitest tests with mock LLM and deterministic embeddings

### What Does NOT Exist

- No Observations table (traces feed directly into memories)
- No Pending queue (traces processed immediately in-process)
- No Worker daemon (observer runs in-process or as one-shot CLI)
- No Session lifecycle management (just upsert)
- No Session summary generation (schema exists, no pipeline)
- No MCP server
- No Web viewer
- No Context injection into agent prompts
- No Installer
- No file-aware retrieval boosting
- No repository scoping beyond project name
- No provenance tracking (sourceTraceIds, sourceObservationIds)
- No local embedding model (uses OpenAI-compatible HTTP API)
- No sqlite-vec (uses in-memory Float32 cosine similarity)
- No memory inspection CLI (`termyte memories`, `termyte memory <id>`, etc.)

---

## 3. Missing Components

### Critical (Blocking MVP)

| Component | Claude-mem | Termyte | Action |
|-----------|-----------|---------|--------|
| Observations table | observations table | Missing | Create schema + store methods |
| Trace→Observation pipeline | SDK Agent → XML → observations | Direct trace→memory | Add observation extraction step |
| Observation→Memory pipeline | Implicit (observation = memory) | Direct trace→memory | Add explicit memory extraction from observations |
| Repository scoping | project column only | project column only | Add repoId, workspaceRoot |
| Memory provenance | content_hash, agent_type | session_id only | Add sourceTraceIds, sourceObservationIds |
| Local embeddings | Chroma (external) | OpenAI HTTP | Replace with Nomic Embed / BGE Small |
| sqlite-vec | Chroma (external) | In-memory Float32 | Replace with sqlite-vec extension |
| Session summaries | Full pipeline | Schema only | Implement summary generation |
| File-aware retrieval | Via Chroma metadata | Not present | Add file boosting to retrieval |
| Memory inspection CLI | Via web viewer | Not present | Add `termyte memories/memory/trace/session` |
| Memory types (new) | bugfix/discovery/decision/etc | bugfix/feature/refactor/etc | Change to bugfix/convention/warning/procedure/fact |

### Non-Critical (Phase 2)

| Component | Status |
|-----------|--------|
| Worker daemon | Not needed for MVP (in-process observer is sufficient) |
| MCP server | Not needed for MVP (CLI-based retrieval is sufficient) |
| Web viewer | Not needed for MVP |
| Pending queue | Not needed for MVP (in-process observer drains immediately) |
| Context injection into agents | Not needed for MVP (CLI context output is sufficient) |
| Installer | Not needed for MVP (manual hook wiring is acceptable) |
| Multi-tenancy/auth | Out of scope |
| Confidence scoring / decay / self-correction | Explicitly excluded per spec |

---

## 4. Porting Strategy

### Architecture Change: Two-Layer → Three-Layer

Claude-mem has: **Pending messages → Observations** (2 layers)

Termyte MVP will have: **Traces → Observations → Memories** (3 layers)

- **Traces**: Immutable, raw agent events. Never discarded. Same as current.
- **Observations**: LLM-extracted structured notes from one or more traces.
  Types: bugfix, convention, warning, procedure, fact.
- **Memories**: Consolidated knowledge derived from observations across
  sessions. Includes provenance tracking.

This improves on claude-mem: traces are preserved (not discarded after
processing), and memories are a distinct layer above observations (not
conflated).

### Schema Changes

```sql
-- NEW: observations table (between traces and memories)
observations(
  id INTEGER PK,
  session_id TEXT NOT NULL FK,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  type TEXT NOT NULL CHECK(bugfix, convention, warning, procedure, fact),
  title TEXT NOT NULL,
  description TEXT,
  files_read TEXT,        -- JSON array
  files_modified TEXT,     -- JSON array
  commands_executed TEXT,  -- JSON array
  source_trace_ids TEXT,   -- JSON array of trace IDs
  created_at INTEGER NOT NULL,
  embedding BLOB           -- Float32 from local model
)

-- MODIFIED: memories table (now derived from observations, not traces)
memories(
  id INTEGER PK,
  session_id TEXT NOT NULL FK,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  type TEXT NOT NULL CHECK(bugfix, convention, warning, procedure, fact),
  title TEXT NOT NULL,
  description TEXT,
  files_read TEXT,
  files_modified TEXT,
  source_observation_ids TEXT,  -- JSON array
  source_trace_ids TEXT,        -- JSON array (transitive)
  created_at INTEGER NOT NULL,
  embedding BLOB
)

-- NEW: session_summaries (existing schema, now wired)
session_summaries(
  -- existing columns +
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL
)
```

### Component Migration Map

| Claude-mem Component | Action | Rationale |
|---------------------|--------|-----------|
| `src/cli/adapters/claude-code.ts` | **Simplify & adopt** | Adapter pattern is clean. Simplify to return NormalizedEvent directly. |
| `src/cli/adapters/codex.ts` | **Simplify & adopt** | Same pattern, strip Codex-specific permission gating (out of scope). |
| `src/cli/adapters/cursor.ts` | **Simplify & adopt** | Same pattern, strip transcript derivation. |
| `src/cli/adapters/gemini-cli.ts` | **Skip** | Not in MVP agent list. |
| `src/cli/adapters/windsurf.ts` | **Skip** | Not in MVP agent list. |
| `src/sdk/parser.ts` (parseAgentXml) | **Adopt directly** | XML grammar is the same. Parser is already ported in Termyte. |
| `src/sdk/prompts.ts` (prompt builders) | **Simplify & adopt** | Keep XML output format. Simplify prompts for new observation types. |
| `src/services/sqlite/SessionStore.ts` | **Skip** | Too large (2000 lines). Termyte's Store is cleaner. |
| `src/services/sqlite/SessionSearch.ts` | **Reference** | Adopt FTS5 query patterns, not the class hierarchy. |
| `src/services/worker/SearchManager.ts` | **Skip** | Over-engineered for MVP. Simple hybrid search is sufficient. |
| `src/services/context/ContextBuilder.ts` | **Reference** | Adopt timeline rendering approach, simplify token budget. |
| `src/services/sync/ChromaSync.ts` | **Skip** | No Chroma. Replaced by sqlite-vec. |
| `src/services/sync/ChromaMcpManager.ts` | **Skip** | No external vector DB. |
| `src/services/worker/SessionManager.ts` | **Skip** | No worker daemon. Session management is simpler in-process. |
| `src/services/worker-service.ts` | **Skip** | No worker daemon. |
| `src/servers/mcp-server.ts` | **Skip** | No MCP server in MVP. |
| `src/services/transcripts/processor.ts` | **Skip** | No transcript watching. Hook-based capture only. |
| `src/services/integrations/*` | **Skip** | No installer needed for MVP. |
| `src/services/context/ContextConfigLoader.ts` | **Skip** | No config file loading. Use simple defaults. |
| `src/services/domain/ModeManager.ts` | **Skip** | No mode system. Fixed observation types. |

---

## 5. Recommended Implementation Order

### Phase 1: Foundation (Schema + Local Embeddings)

1. **Install sqlite-vec**: Add native extension for vector search
2. **Update schema**: Add `observations` table, modify `memories` with
   provenance columns, add `repo_id`/`workspace_root` everywhere
3. **Implement local embeddings**: Nomic Embed (primary) or BGE Small
   (fallback) via `nomic-embed-text` or `@xenova/transformers`
4. **Update core types**: New observation types, memory provenance types

### Phase 2: Three-Layer Pipeline

5. **Observation extraction**: New observer stage that takes traces →
   produces observations (not memories). Uses LLM with new prompt.
6. **Memory extraction**: New observer stage that takes observations →
   produces memories. Uses LLM with consolidation prompt.
7. **Session summaries**: Wire summary generation at session end.

### Phase 3: Retrieval + CLI

8. **sqlite-vec vector search**: Replace in-memory cosine similarity with
   persisted vector index.
9. **File-aware retrieval**: Add file boosting to hybrid search.
10. **Memory inspection CLI**: `termyte memories`, `termyte memory <id>`,
    `termyte trace <id>`, `termyte session <id>`.
11. **Update context builder**: Render observations + memories + summaries.

### Phase 4: Polish

12. **Update all tests** for new schema and pipeline.
13. **Cross-agent testing**: Verify all 4 adapters produce correct traces.
14. **Documentation**: Update README with new architecture.

---

## 6. Components to Reuse Directly

From Claude-mem:
- **`parseAgentXml()`** (`src/sdk/parser.ts`): Already ported to Termyte.
  XML grammar is stable. Keep as-is.

- **`buildObservationPrompt()` / `buildSystemPrompt()`** (`src/sdk/prompts.ts`):
  Adapt the prompt structure (XML format, skip guidance) but change
  observation types and concepts to match Termyte's types.

- **FTS5 content-sync triggers**: The pattern of using `CREATE TRIGGER ...
  AFTER INSERT ON memories BEGIN INSERT INTO memories_fts ...` is correct.
  Extend to observations.

- **Adapter pattern**: `PlatformAdapter` interface with `normalize(raw):
  NormalizedEvent`. Termyte's current interface is already simpler than
  claude-mem's. Keep it.

- **RRF combination**: The 5-line RRF implementation (k=60) works. Keep it.

From Termyte (current):
- **`Store` class**: Clean CRUD with JSON serialization at the boundary.
  Extend, don't replace.
- **`Observer` class**: In-process + standalone modes. Extend for two-stage
  pipeline (observation then memory).
- **`HybridSearch` class**: FTS5 + vector + RRF. Add file boosting.
- **All 4 adapters**: Already normalized. Add repo detection.

---

## 7. Components to Simplify

| Claude-mem Component | Simplification |
|---------------------|---------------|
| Dual session IDs | Single session ID. No `content_session_id` vs `memory_session_id`. |
| Mode system (28 JSON files) | Hardcoded observation types: bugfix, convention, warning, procedure, fact. |
| SDK Agent integration | Direct OpenAI-compatible API calls (already in Termyte). |
| 22 HTTP routes | None. CLI-only for MVP. |
| Context injection (4 mechanisms) | Single CLI output format. |
| Pending queue (SQLite-backed) | In-memory queue drained in-process. |
| Chroma MCP management | sqlite-vec extension (no separate process). |
| Session restart/abort controllers | Not needed for in-process observer. |
| Telemetry (PostHog) | None. |
| i18n (28 languages) | English only. |
| Plugin marketplace + skills | None. |

---

## 8. Components NOT to Copy

1. **Worker daemon** (`worker-service.ts`, 2500 lines): Termyte's in-process
   observer is sufficient for MVP. The worker daemon exists because claude-mem
   needs a persistent process to manage the Claude Agent SDK's stateful
   sessions. Termyte uses stateless OpenAI API calls.

2. **Chroma + chroma-mcp** (`ChromaSync.ts`, `ChromaMcpManager.ts`): External
   Python process with fragile dependency management. Replaced by sqlite-vec.

3. **Mode system** (`ModeManager.ts`, 28 JSON files): Over-engineered for a
   developer tool. Fixed types are simpler.

4. **Server beta** (Postgres, Redis/BullMQ, BetterAuth, teams): Multi-tenant
   SaaS infrastructure. Not needed for a local-first tool.

5. **Transcript watcher** (`TranscriptEventProcessor`, `TranscriptWatcher`):
   Complex file-tail-based capture as an alternative to hook-based capture.
   Hook-based capture is simpler and works for all platforms.

6. **Context injection infrastructure** (`context-injection.ts`,
   `ContextConfigLoader.ts`, `TokenCalculator.ts`, 4 formatters): Termyte
   only needs CLI output for the MVP. Agent prompt injection can be added
   later as a separate concern.

7. **SSE broadcaster + React viewer**: Not needed for CLI-only MVP.

8. **Integration installers** (`CodexCliInstaller.ts`, etc.): Manual hook
   wiring is acceptable for MVP.

9. **Dual session ID system**: Single session ID is sufficient when not
   using the Claude Agent SDK's resume feature.

---

## 9. Architecture Decision: Why Three Layers

Claude-mem conflates "observation" and "memory" — what it calls an
"observation" IS the memory. There is no distinction between a
per-tool observation and a consolidated memory.

Termyte's three-layer approach:

```
Traces (raw, immutable, per-event)
  ↓ (LLM extracts per-tool observations)
Observations (per-tool, structured, ephemeral source)
  ↓ (LLM consolidates across observations)
Memories (cross-session, consolidated, durable)
```

Benefits:
- **Provenance**: Memories trace back to observations which trace back to
  traces. Full audit chain.
- **Quality**: Two-stage extraction (observation then consolidation) produces
  better memories than one-stage (observation that IS memory).
- **Evolution**: Observations can be re-consolidated when new information
  arrives without losing original observations.
- **Explainability**: Users can inspect any memory and walk back through
  observations to the original traces.

This is the architectural improvement over claude-mem that the MVP
requirements specify.

---

## 10. Implementation Notes

### sqlite-vec

The `sqlite-vec` extension provides vector search natively in SQLite.
It replaces both Chroma (external) and in-memory Float32 arrays (brittle).

```sql
-- Create a virtual table for vector search
CREATE VIRTUAL TABLE memories_vec USING vec0(
  embedding float[384]  -- dimension from Nomic Embed
);

-- Insert embeddings
INSERT INTO memories_vec(rowid, embedding)
VALUES (?, ?);  -- ? = memory_row_id, ? = Float32Array as BLOB

-- Search
SELECT rowid, distance
FROM memories_vec
WHERE embedding MATCH ?
ORDER BY distance
LIMIT ?;
```

### Local Embeddings (Nomic Embed)

Nomic Embed Text v1.5 produces 768-dim embeddings (matryoshka-capable,
can be truncated to 384). Use `nomic-embed-text` npm package or
`@xenova/transformers` with the `nomic-ai/nomic-embed-text-v1.5` model.

```typescript
import { pipeline } from "@xenova/transformers";
const embedder = await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5");
const embedding = await embedder(text, { pooling: "mean", normalize: true });
```

Fallback: BGE Small (`BAAI/bge-small-en-v1.5`, 384 dims).

### Observation → Memory Prompt

The observation-to-memory stage consolidates multiple observations into
a single memory. Input is a batch of observations from the same session.
Output is a consolidated memory that captures the durable knowledge.

This is the key architectural difference from claude-mem: a second LLM
pass that synthesizes observations into memories, rather than treating
each observation as a standalone memory.
