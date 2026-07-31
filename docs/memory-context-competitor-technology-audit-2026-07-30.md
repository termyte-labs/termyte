# Open-source memory and context products: technical audit

Date: 2026-07-30  
Products inspected: CodeAlmanac, claude-mem, Supermemory, Cognee  
Method: local source-code inspection from the repositories returned by `opensrc list`.

## Executive conclusion

These products are not four versions of the same system.

| Product | Actual product shape | Main input | Canonical memory | Retrieval | Agent delivery |
|---|---|---|---|---|---|
| CodeAlmanac | Repository-owned technical wiki | Finished Codex and Claude transcripts | Markdown files in `almanac/` | SQLite FTS5 index over Markdown sections, with topic and file filters | Agent searches or reads the wiki |
| claude-mem | Local coding-session memory runtime | Claude Code hooks and tool events | Structured observations, prompts, and session summaries in SQLite; server mode also has PostgreSQL workflows | SQLite text/filter search; optional Chroma semantic search; file lookup | Automatic session-start context plus search tools and file-read context |
| Supermemory | Hosted general-purpose memory service | Explicit API, SDK, or MCP `memory` calls | Not verifiable in this open repository; clients expose documents, extracted memories, profiles, and versions | Hosted hybrid search with optional query rewrite and reranking | MCP tools/resources and AI SDK tools |
| Cognee | General knowledge ingestion and graph/RAG framework | Text, files, URLs, streams, structured sources | Relational metadata plus vector and graph stores | Many explicit retrievers: chunks, summaries, BM25, hybrid, graph, temporal, code, and agentic | Python API, REST/API surfaces, MCP, or application-controlled prompt assembly |

The closest direct technical competitor to Termyte is **claude-mem**, because it captures live coding-agent events and injects prior work into later sessions. CodeAlmanac competes at the repository-knowledge layer. Cognee competes as infrastructure that someone could use to build a memory system. Supermemory competes as a hosted memory API, but its central storage and synthesis implementation is not present in the inspected open repository.

The main opening for Termyte is still clear: none of the four codebases proves a complete loop that identifies the agent's current task, links it to live engineering sources, validates old facts against current code, builds a small task-specific briefing, and records whether that briefing improved the outcome.

## Audit standard

This report treats executable code, schemas, and tests as evidence. README claims and tool descriptions help explain intent, but they are not proof of an internal implementation.

Verdicts used below:

- **Verified:** direct implementation is present.
- **Partially verified:** a real implementation exists, but an important part is absent or indirect.
- **Interface only:** the repository contains a client or adapter to a separate service.
- **Not found:** no supporting implementation was found in the inspected paths.

This is a static audit. I did not run each product end to end, inspect its production deployment, or measure retrieval quality.

## 1. CodeAlmanac

### What it is

CodeAlmanac converts prior coding sessions into a repository-owned Markdown wiki. Its key product choice is that the human-readable wiki is canonical and SQLite is a rebuildable search index.

This is closer to automated documentation than to a live task-memory control plane.

### End-to-end workflow

```text
Codex/Claude transcript files
        ↓
discover sessions whose working directory exactly matches a registered repo
        ↓
queue one background ingest job per repo
        ↓
render transcript text, capped at roughly 60,000 characters
        ↓
give transcript plus wiki instructions to a coding agent
        ↓
agent creates or edits Markdown under almanac/
        ↓
parse pages, headings, sources, file references, and links
        ↓
build section-level SQLite FTS5 index
        ↓
search by words, topics, or referenced files
```

### Capture

**Verified.** It scans local transcript stores rather than installing a live hook into every agent action.

- The Codex source scans `.codex/sessions`, reads JSONL, extracts session ID and working directory, and skips subagent records: [codex.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/integrations/sources/transcripts/codex.py).
- The Claude source performs similar discovery under `.claude/projects`: [claude.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/integrations/sources/transcripts/claude.py).
- A transcript is eligible only when its recorded working directory matches the registered repository: [evaluation.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/workflows/sync/evaluation.py).

This gives simple repository scoping, but it is weaker than explicit task identification. A session run from a monorepo root may touch several tasks, while a session run from a child directory may fail an exact-directory check.

### What it stores

**Verified.** The durable knowledge is Markdown. The derived SQLite schema stores:

- pages and topics;
- page-to-source records;
- file references and page links;
- page sections;
- an FTS5 section index.

Source frontmatter supports file, web, commit, pull request, issue, conversation, wiki, and manual sources: [frontmatter.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/services/wiki/frontmatter.py). The index schema is in [schema.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/services/index/schema.py).

The conversation provenance is fairly coarse: it can name a transcript path, run ID, or session ID, but it does not preserve an exact source event for each derived sentence. This makes human audit possible, but precise fact-level verification expensive.

### Synthesis

**Verified.** Synthesis is performed by a coding agent guided by prompt instructions, not by a deterministic parser. The instructions ask it to extract decisions, flows, invariants, incidents, and gotchas, cite non-obvious facts, and edit the wiki directly: [ingest instructions](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/agents/ingest/instructions.md).

The transcript renderer has a default maximum near 60,000 characters and keeps the tail when truncating: [runtime.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/integrations/sources/transcripts/runtime.py), [rendering.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/integrations/sources/transcripts/rendering.py). Tail retention preserves recent outcomes, but can discard the original request, early constraints, and rejected approaches.

### Retrieval

**Verified.** Search is lexical and structure-aware rather than semantic. It uses BM25 through SQLite FTS5 at heading-section level. It can filter by topic and by exact file or directory mentions: [search_views.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/services/index/search_views.py).

This is a good fit for code identifiers, filenames, error strings, and named architecture concepts. It will be weaker for paraphrases unless the wiki writer included similar words.

### Feeding context to an agent

The agent reads or searches the wiki. The system does not appear to infer a structured current task and automatically assemble a bounded task packet. Context quality therefore depends on the calling agent knowing when and how to search.

### Important failure mode

The queue records a sync watermark even when worker spawn fails. Tests explicitly preserve that behavior: [queue.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/src/codealmanac/workflows/sync/queue.py), [test_sync_workflow.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/tests/test_sync_workflow.py). A transcript can therefore become older than the watermark without ever being ingested. That is a retry/data-loss risk.

The ingest boundary is also enforced mainly through prompting. Tests show that a harness can mutate an application file and the workflow may still report success: [test_ingest_workflow.py](C:/Users/Palguna/.opensrc/repos/github.com/AlmanacCode/codealmanac/main/tests/test_ingest_workflow.py).

### Verdict

**Real early product; partially durable pipeline.** Strong simple architecture and good repo-native UX. Weak task awareness, coarse provenance, and risky job completion semantics.

## 2. claude-mem

### What it is

claude-mem is a local-first coding-session memory system built around Claude Code lifecycle hooks. It captures prompts and tool activity, turns them into typed observations and session summaries, stores them locally, and injects a compact timeline into later sessions.

### End-to-end workflow

```text
Claude Code lifecycle event
        ↓
Setup / SessionStart / UserPromptSubmit / PreToolUse(Read) / PostToolUse / Stop hooks
        ↓
local worker service receives prompt, tool, file, and session events
        ↓
provider-backed generation creates observations or summaries
        ↓
store structured memory item plus source/session/project fields
        ↓
maintain SQLite FTS index; optionally synchronize semantic index
        ↓
new SessionStart builds project timeline and injects it
        ↓
explicit search can use text, filters, semantic search, or file lookup
```

### Capture

**Verified.** The hook manifest wires several stages of the coding session:

- `SessionStart` starts the worker and requests context injection.
- `UserPromptSubmit` initializes session state.
- `PostToolUse` asynchronously records observations.
- `PreToolUse` for reads requests file-related context.
- `Stop` asynchronously requests a session summary.

See [hooks.json](C:/Users/Palguna/.opensrc/repos/github.com/thedotmack/claude-mem/main/plugin/hooks/hooks.json:17).

This is much closer to the real agent loop than retrospective transcript scanning. It can preserve tool-level timing and files read or changed. It is still platform-coupled: its deepest integration is with Claude Code hooks, although the schema includes a platform source field.

### What it stores

**Verified.** Its SQLite schema is versioned and structured. It includes projects, teams, team members, server sessions, raw agent events, memory items, memory sources, API keys, and audit logs: [schema.ts](C:/Users/Palguna/.opensrc/repos/github.com/thedotmack/claude-mem/main/src/storage/sqlite/schema.ts).

A memory item can represent an observation, summary, prompt, or manual memory. It stores:

- type, title, subtitle, text, and narrative;
- JSON facts and concepts;
- files read and files modified;
- project and session links;
- metadata and timestamps.

Memory sources preserve source type and legacy IDs/URIs. FTS5 indexes title, subtitle, text, narrative, facts, and concepts using a Porter/Unicode tokenizer: [schema.ts](C:/Users/Palguna/.opensrc/repos/github.com/thedotmack/claude-mem/main/src/storage/sqlite/schema.ts:171).

This is the strongest inspected schema for retaining both concise memory and machine-filterable evidence. It still does not prove that every generated fact has an exact pointer back to a raw event span.

### Synthesis

**Verified.** Tool events are sent to an LLM/provider-backed generation layer that produces typed observations. A Stop event produces a broader session summary. The server-oriented implementation uses BullMQ and a PostgreSQL outbox with tenant and API-key checks before generation and transactional persistence afterward: [ProviderObservationGenerator.ts](C:/Users/Palguna/.opensrc/repos/github.com/thedotmack/claude-mem/main/src/server/generation/ProviderObservationGenerator.ts).

The key design is progressive compression:

1. Keep raw agent events.
2. Convert useful events into observations.
3. Convert a completed session into a summary.
4. Render only selected full observations while compacting older items into a timeline.

That is better than keeping only summaries because later retrieval can still target observation type, concepts, files, project, date, and platform.

### Retrieval

**Verified.** There are two main paths:

- Context injection reads observations and summaries for the current project, builds a timeline, selects a limited number of full observations, includes the latest summary, and estimates token savings: [ContextBuilder.ts](C:/Users/Palguna/.opensrc/repos/github.com/thedotmack/claude-mem/main/src/services/context/ContextBuilder.ts).
- Search supports observation/session/prompt types, project, platform, concepts, files, dates, ordering, limits, and offsets: [SQLiteSearchStrategy.ts](C:/Users/Palguna/.opensrc/repos/github.com/thedotmack/claude-mem/main/src/services/worker/search/strategies/SQLiteSearchStrategy.ts).

When Chroma is configured, a text query uses semantic search. Filter-only queries use SQLite. File lookup can use a hybrid strategy. The orchestrator falls back to SQLite for a platform-scoped empty Chroma result, but a general Chroma failure is wrapped as an unavailable error instead of always degrading to FTS: [SearchOrchestrator.ts](C:/Users/Palguna/.opensrc/repos/github.com/thedotmack/claude-mem/main/src/services/worker/search/SearchOrchestrator.ts).

### Feeding context to an agent

**Verified.** Context is automatically returned on session start. A file-read hook can supply context related to the file about to be opened. Explicit search remains available for focused recall.

The automatic session packet is project-based and recency/config based. It is not clearly driven by a separately inferred task object. That means it can restore continuity, but relevance may degrade when a repository contains several unrelated active tasks.

### Strengths

- Captures work at the time it happens.
- Separates raw events, observations, summaries, and sources.
- Uses typed fields that support deterministic filtering.
- Has a bounded context renderer and token accounting.
- Supports local SQLite and a more durable queued server path.
- Connects retrieval to session start and file reads instead of requiring perfect agent behavior.

### Weaknesses

- Strong coupling to one agent's hook surface.
- Current-task recognition is mostly implicit through project/session/file state.
- LLM-derived memory can still be wrong; exact evidence linkage is not obvious for every fact.
- Optional semantic infrastructure increases operating complexity.
- Context-by-recency can inject irrelevant history.
- Chroma failure behavior is not a universal lexical fallback.

### Verdict

**Substantial direct competitor.** It proves that hook capture, structured synthesis, local storage, search, and automatic context injection are practical today. Its main unproven step is high-quality task-specific selection and causal improvement in coding outcomes.

## 3. Supermemory

### What it is

Supermemory exposes a general memory service through an SDK, MCP server, browser and application integrations. The open repository is best understood as an integration monorepo around a hosted API.

### What the open code proves

**Verified interface.** The MCP server registers tools to save/forget memories, recall, list memories, list projects, and work with a user profile: [server.ts](C:/Users/Palguna/.opensrc/repos/github.com/supermemoryai/supermemory/main/apps/mcp/src/server.ts:145).

Memories are scoped using a `containerTag`, which acts like a project or namespace. The client sends content to the hosted API and marks MCP as the source: [client.ts](C:/Users/Palguna/.opensrc/repos/github.com/supermemoryai/supermemory/main/apps/mcp/src/client.ts:154).

The public client types expose:

- documents;
- extracted memory entries;
- static and dynamic profile facts;
- similarity scores;
- memory version, parent/root relationships;
- forgotten state, reason, and expiry;
- metadata and related documents.

The MCP client supports search modes named `memories`, `hybrid`, and `documents`, plus reranking, query rewriting, and optional documents, related memories, summaries, chunks, and forgotten memories: [client.ts](C:/Users/Palguna/.opensrc/repos/github.com/supermemoryai/supermemory/main/apps/mcp/src/client.ts:38).

The AI SDK package exposes two simple tools. `searchMemories` calls hosted search with a 0.6 chunk threshold and optional full documents; `addMemory` sends a short memory to the service: [tools.ts](C:/Users/Palguna/.opensrc/repos/github.com/supermemoryai/supermemory/main/packages/ai-sdk/src/tools.ts:70).

### What is not proved by this repository

**Interface only.** The inspected code does not expose the central hosted implementation for:

- database schema and canonical storage;
- chunking and embedding logic;
- fact extraction or profile synthesis prompts;
- contradiction handling;
- memory consolidation and version creation;
- hybrid scoring and reranking;
- deletion guarantees;
- tenancy enforcement inside the main API.

The names and response types show that these capabilities exist at the API boundary. They do not show how well or safely the service implements them.

### Workflow

```text
application or agent decides something is memorable
        ↓
explicit SDK/MCP add call with content and container tag
        ↓
hosted service queues processing
        ↓
[closed implementation: extraction, indexing, profile updates]
        ↓
agent calls recall with natural-language query
        ↓
hosted service returns memories/documents/profile
        ↓
MCP or SDK inserts tool result into the model conversation
```

The product delegates the most important capture decision to the agent or application: when should a fact be saved? Tool descriptions encourage saving durable preferences or facts, but descriptions are behavioral prompts, not enforcement.

### Forgetting behavior

**Verified at client level.** The MCP client first tries exact content forgetting. On a 404 it performs semantic search with a high similarity threshold of 0.85, chooses an actual memory rather than a document chunk, and then forgets by ID: [client.ts](C:/Users/Palguna/.opensrc/repos/github.com/supermemoryai/supermemory/main/apps/mcp/src/client.ts:176).

This is user-friendly but potentially risky: semantic deletion can remove a similar memory that is not the intended one. A safer product would show the match and request confirmation unless the ID is exact.

### Feeding context

**Verified.** Delivery happens through MCP tool results, MCP resources such as `supermemory://profile`, or AI SDK tool results. Recall is demand-driven; it is not inherently tied to coding-agent task detection, repository state, commits, files, or tests.

### Verdict

**Real integration product; core engine not auditable here.** It demonstrates a clean universal memory API and good distribution through MCP/SDKs. It does not provide code evidence for the central synthesis and storage claims that matter most to Termyte.

## 4. Cognee

### What it is

Cognee is a broad knowledge-engineering framework. It ingests many data types, turns content into chunks, embeddings, and a knowledge graph, and offers many retrieval strategies. It is not specifically a coding-agent continuity product.

### End-to-end workflow

```text
text / file / URL / binary / structured source
        ↓ cognee.add()
resolve source, extract content, store data and permissions
        ↓ cognee.cognify()
chunk documents, summarize or classify, embed, extract graph with LLM
        ↓
integrate entities and edges using ontology resolver
        ↓
persist relational metadata + vector index + graph
        ↓ cognee.search()
authorize datasets, select retriever, collect context
        ↓
return raw context or generate a completion with optional references
```

### Capture and ingestion

**Verified.** `add()` accepts text, paths, URLs, streams, lists, and structured sources. It resolves an authorized dataset and runs an ingestion pipeline: [add.py](C:/Users/Palguna/.opensrc/repos/github.com/topoteretes/cognee/main/cognee/api/v1/add/add.py:25).

This is flexible source ingestion, not automatic agent tracing. A Termyte-style connector would have to transform prompts, tool events, git state, tickets, and messages into Cognee inputs.

### Synthesis

**Verified.** `cognify()` assembles processing tasks and creates knowledge representations: [cognify.py](C:/Users/Palguna/.opensrc/repos/github.com/topoteretes/cognee/main/cognee/api/v1/cognify/cognify.py:43). Graph extraction calls an LLM for non-structured chunks, filters edges with missing nodes, resolves entities through an ontology resolver, and integrates the chunk graphs: [extract_graph_from_data.py](C:/Users/Palguna/.opensrc/repos/github.com/topoteretes/cognee/main/cognee/tasks/graph/extract_graph_from_data.py:130).

Structured DLT rows can bypass LLM graph extraction and build relationships deterministically from schema metadata. This is an important principle: use deterministic extraction when the source already has structure, and reserve LLM synthesis for ambiguous text.

### Storage

**Verified architecture.** Cognee separates storage roles:

- relational database for datasets, documents, users, permissions, and pipeline state;
- vector database for chunk/entity embeddings;
- graph database for entities and relationships.

Default and optional adapters include local and hosted choices, such as SQLite/PostgreSQL, LanceDB/pgvector, and Kuzu/Neo4j-style graph backends. This makes Cognee deployable across many environments, but it also makes correctness and operations more complex than a single-ledger product.

### Retrieval

**Verified.** Search is an explicit strategy factory. Search types include summaries, chunks, RAG completion, hybrid completion, triplets, several graph completion modes, Cypher, natural language, temporal, coding rules, lexical chunks, agentic completion, and code: [SearchType.py](C:/Users/Palguna/.opensrc/repos/github.com/topoteretes/cognee/main/cognee/modules/search/types/SearchType.py:4).

The retriever registry passes controls such as `top_k`, node filters, neighborhood depth, session ID, feedback influence, and optional references: [get_search_type_retriever_instance.py](C:/Users/Palguna/.opensrc/repos/github.com/topoteretes/cognee/main/cognee/modules/search/methods/get_search_type_retriever_instance.py:79).

The public search path checks dataset authorization, retrieves per dataset, supports context-only output, and avoids saving unbounded raw graph context into search history: [search.py](C:/Users/Palguna/.opensrc/repos/github.com/topoteretes/cognee/main/cognee/modules/search/methods/search.py).

### Feeding context

Cognee returns retrieved context or an LLM-generated answer to the caller. The application decides when to call it and what to put into the agent prompt. It offers MCP/API integration, but it does not by itself know the coding agent's active task.

### Strengths

- Clear `add → cognify → search` pipeline.
- Strong source-format and backend flexibility.
- Both lexical/vector retrieval and graph traversal.
- Dataset permissions and optional references.
- Deterministic handling for structured relationships.
- Pluggable tasks and retrievers.

### Weaknesses

- More infrastructure than Termyte needs for an initial proof.
- A knowledge graph does not automatically solve current-task selection.
- LLM graph extraction can create wrong entities or relationships.
- Multiple databases create consistency, migration, and deletion work.
- Search strategy choice is pushed to the caller or a selector.
- Generic document ingestion lacks coding-session meaning such as attempt, failure, test, decision, or completion.

### Verdict

**Mature general framework, indirect competitor.** Useful source of pipeline and retrieval ideas. Adopting it wholesale would likely hide Termyte's main product question beneath graph and adapter complexity.

## Cross-product comparison

### Capture

| Question | CodeAlmanac | claude-mem | Supermemory | Cognee |
|---|---|---|---|---|
| Automatic coding trace capture | Retrospective transcript scan | Yes, lifecycle hooks | No; caller invokes tools/API | No; caller invokes ingestion |
| User prompts | From transcript | Direct hook/session storage | Only if caller saves them | If supplied as data |
| Tool calls/results | From transcript prose/JSONL | Direct PostToolUse observations | Only if caller saves them | If supplied as data |
| File awareness | Extracted and indexed from wiki | Files read/modified plus file-read hook | Generic metadata/documents | Code/document loaders and graph |
| Git commit awareness | Source type supports commits | Can appear in captured events/metadata | No native coding meaning | Can ingest it, not native task state |
| External tracker/chat | Not in core inspected flow | Not in core inspected flow | Generic API can receive it | Connectors can ingest it |

### Memory model

| Product | Raw evidence | Derived units | Human editable | Evidence precision |
|---|---|---|---|---|
| CodeAlmanac | External transcripts | Wiki pages and sections | Yes, Markdown | Session/source-level, often coarse |
| claude-mem | Agent events | Typed observations and summaries | Through application/UI, not plain repo docs | Better structured links, exact fact span not always clear |
| Supermemory | Hidden hosted documents | Extracted memories and profiles | Through API/UI | Cannot be verified from open core |
| Cognee | Ingested documents/chunks | Embeddings, summaries, entities, edges | Source-dependent | References optional; graph claims are derived |

### Retrieval and delivery

| Product | Lexical | Vector | Graph | Deterministic filters | Automatic injection |
|---|---:|---:|---:|---:|---:|
| CodeAlmanac | Yes, FTS5/BM25 | No | Wiki links only | Topic/file | No clear task packet |
| claude-mem | Yes, SQLite | Optional Chroma | No | Project/file/type/concept/date/platform | Yes, session and file hooks |
| Supermemory | Hosted, unknown mix | API exposes similarity/hybrid | API types mention related memory; implementation hidden | Container/project and include options | Tool/resource driven |
| Cognee | BM25 option | Yes | Yes | Dataset/node/search-type controls | Caller controlled |

## What these systems teach us

### 1. Keep raw evidence and derived memory separate

claude-mem has the best inspected layering: raw events, observations, summaries, and source records. CodeAlmanac jumps from transcript to prose wiki. Cognee preserves documents/chunks and builds derived graph objects. Supermemory's API also distinguishes documents from extracted memory entries, though the implementation is hidden.

Termyte should never make an LLM summary the only durable copy. A useful minimum is:

```text
source event → normalized observation → task/work-thread claim → delivered context item → outcome
```

Every arrow should be traceable.

### 2. Use a ledger as canonical storage; generate Markdown as a view

The products support a clear answer to the earlier SQLite-versus-wiki question:

- Markdown is excellent for human review, git history, and agent reading.
- A structured ledger is better for deduplication, lifecycle, source links, invalidation, task membership, access control, ranking signals, and outcome measurement.

Termyte should use SQLite locally, and a relational event ledger in Cloud, as canonical truth. It can generate a Markdown Work Thread or briefing as a materialized view. Copy CodeAlmanac's readability, not its loss of typed state.

### 3. Task detection is the missing layer

These products mostly scope by repository, project/container, dataset, session, file, or query. Those are useful signals, but none is the task itself.

Termyte should maintain an explicit task hypothesis:

```json
{
  "task_id": "wt_...",
  "title": "Fix signup returning 401",
  "intent": "Restore browser signup",
  "status": "active",
  "repo": "termyte-cloud",
  "branch": "fix/auth",
  "entities": ["Supabase", "signup", "anon key"],
  "files": ["src/auth.ts"],
  "local_refs": ["session:tm_123", "commit:31c5..."],
  "confidence": 0.88,
  "evidence_event_ids": ["ev_1", "ev_7"]
}
```

Update it from the latest user prompt, local branch and commit state, files touched, commands, errors, tests, and session history. Do not silently merge a new task into an old one when confidence is low.

### 4. Retrieval should be staged, not one vector query

A good Termyte retrieval flow combines the strongest ideas from these products:

1. **Hard scope:** tenant, repository, access, deletion state.
2. **Task candidates:** active Work Thread, explicit issue/branch, recent related sessions.
3. **Exact evidence:** paths, symbols, errors, commands, issue IDs, names.
4. **Lexical search:** FTS5/BM25 for identifiers and exact language.
5. **Semantic search:** only to recover paraphrased candidates.
6. **Typed reranking:** task match, source freshness, file overlap, outcome value, confidence, recency.
7. **Freshness validation:** compare commit, file hashes, issue state, and source timestamps.
8. **Context assembly:** return a bounded packet with facts, prior attempts, changed files, tests, open questions, and source pointers.

Vector similarity should find candidates, not decide truth.

### 5. Context delivery must sit in the agent loop

claude-mem shows the strongest distribution pattern: deliver at session start and before a relevant file read, while still exposing search. CodeAlmanac depends more on the agent remembering to search. Supermemory depends on tool-calling behavior. Cognee leaves delivery to the host application.

Termyte should support three delivery points:

- **Session/task start:** a small briefing.
- **Before action:** file, command, or source-specific warnings and past evidence.
- **On demand:** MCP/CLI retrieval for deeper detail.

Automatic delivery must remain small. Exact code should be opened from the repository rather than replaced by stale prose.

### 6. Synthesis should be typed and evidence-bound

Use the LLM for classification and compression, but make it return a strict schema:

```json
{
  "kind": "decision",
  "claim": "Browser signup must use the Supabase anon key",
  "reason": "Service keys must remain server-side",
  "task_id": "wt_123",
  "entities": ["Supabase", "signup"],
  "files": ["src/auth.ts"],
  "evidence": [
    {"event_id": "ev_42", "span": "...", "commit": "31c5..."}
  ],
  "confidence": 0.92,
  "valid_until": null
}
```

Reject or quarantine claims without evidence. Keep deterministic facts—command exit codes, changed paths, git commits, test results—as machine-generated records rather than asking an LLM to restate them.

### 7. Completion and failure are first-class memory

The competitors focus mostly on facts, observations, summaries, or graph entities. Termyte should treat attempts and outcomes as primary units:

- what was attempted;
- why it was attempted;
- exact command or edit;
- result and error;
- whether it was reverted;
- test or build proof;
- what remains open.

This prevents agents from repeating failed work and gives Termyte a measurable link between context and outcome.

## Recommended Termyte architecture

```text
Local agent hooks + local transcripts + local git
                    ↓
              immutable source events
                    ↓
       deterministic normalization and anchors
                    ↓
        LLM typed observations with evidence
                    ↓
      task hypothesis / Work Thread state machine
                    ↓
        SQLite ledger + FTS5 indexes
        optional embeddings as candidate recall
                    ↓
 freshness checks against current source state
                    ↓
 bounded Context Briefing with source pointers
                    ↓
 agent action, test result, and completion receipt
                    ↺
```

### Canonical local tables

A minimal local design should include:

- `source_events`: immutable prompt, tool, local git, filesystem, and result events;
- `artifacts`: files, commits, session messages, commands, tests;
- `observations`: typed LLM or deterministic facts;
- `observation_evidence`: many-to-many exact links and spans;
- `work_threads`: current task hypothesis and lifecycle;
- `work_thread_membership`: event/observation membership with confidence;
- `attempts`: action, reason, result, and status;
- `context_packets`: exact items delivered to an agent;
- `outcomes`: completion, test, build, user correction, or failure;
- FTS5 tables over selected text fields.

Embeddings can be added after lexical/task retrieval has a measured recall gap. A graph database is unnecessary for the first product proof; relational edges are enough.

This architecture is completely local. It does not require GitHub, Slack, issue trackers, hosted connectors, or a Cloud service. Repository files, local git state, coding-agent traces, commands, tests, and the SQLite ledger are the complete evidence boundary.

## What to copy and what to avoid

### Copy

- From CodeAlmanac: repo-readable Markdown output, section-level indexing, file-aware search.
- From claude-mem: lifecycle hooks, structured observations, progressive compression, bounded injection, file-triggered recall, local-first SQLite.
- From Supermemory: small universal MCP/SDK surface, project/container scoping, explicit forgetting and audit views.
- From Cognee: pipeline stages, authorization before retrieval, deterministic processing for structured sources, pluggable retrievers, optional references.

### Avoid

- Advancing ingestion watermarks before durable success.
- Treating prompts as a security boundary for filesystem writes.
- Keeping only summaries and losing raw evidence.
- Using repository or recency as a substitute for task identity.
- Letting an agent decide all save/recall behavior through tool descriptions.
- Semantic deletion without exact identity or confirmation.
- Adding graph/vector infrastructure before measuring a retrieval need.
- Returning large “memory dumps” instead of bounded task packets.
- Calling generated prose “current truth” without source freshness checks.

## Product differentiation for Termyte

Weak category language would be “shared memory,” “living documentation,” or “agents stay aligned.” Each competitor can already claim some version of that.

The sharper distinction is:

> Termyte reconstructs the active engineering task from live sources, gives the coding agent a small evidence-linked briefing, and records whether the work actually succeeded.

That has four concrete differences:

1. **Work Thread, not generic memory:** context is organized around an active task and its state.
2. **Current truth, not just history:** old claims are checked against present code, commits, tickets, and messages.
3. **Attempts and outcomes, not only facts:** failed paths and validation results are first-class.
4. **Measured usefulness:** every delivered context item can be tied to an agent action and outcome.

## How to test the distinction

Build a controlled benchmark with repeated tasks across sessions:

- baseline agent with repository search only;
- agent with a large generic memory dump;
- agent with lexical retrieval of prior sessions;
- agent with Termyte's task-aware, freshness-checked Context Briefing.

Measure:

- task completion rate;
- time and tokens to first correct action;
- repeated failed attempts;
- stale-context mistakes;
- source-opening behavior;
- correctness of cited evidence;
- context precision: used items divided by delivered items;
- context recall: required prior facts successfully delivered;
- user corrections and manual context gathering.

The product claim is supported only if Termyte improves these outcomes over normal repository search. Capturing more data or producing good-looking summaries is not enough.

## Final ranking for Termyte relevance

1. **claude-mem:** study deeply for capture, synthesis layers, local schema, and injection timing.
2. **CodeAlmanac:** study for human-readable repo knowledge and section/file retrieval; avoid its retry and coarse-provenance weaknesses.
3. **Cognee:** use as a menu of retrieval and pipeline techniques, not as the initial architecture.
4. **Supermemory:** study its API and distribution design; do not infer its backend quality from this integration repository.

## Second-pass critique and remaining proof gaps

This audit is intentionally skeptical, but static source reading has limits:

- Code paths may be unused or differently configured in released builds.
- I did not measure hallucination rates of wiki pages, observations, profiles, or graph edges.
- I did not test crash recovery, concurrent writes, migrations, deletion, or large repositories.
- Supermemory's central engine cannot be judged from this repository.
- Optional backends in Cognee and claude-mem were not deployed.
- No product was benchmarked on the same multi-session coding tasks.

The next useful research step is not another broad feature comparison. It is a shared hands-on trial: feed the same multi-session bug-fix trace into CodeAlmanac, claude-mem, Cognee, and Termyte; then measure which exact prior facts each retrieves for the second session, what stale or irrelevant context it supplies, and whether the agent completes the task faster.
