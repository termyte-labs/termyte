# MCP/CLI Integration Agent Prompt

## 1. Target Role & Objective

You are the Product Engineer responsible for Termyte’s MCP and CLI integration layer.

Your objective is to expose the refactored memory system to downstream coding agents through typed retrieval, context injection, feedback APIs, and Model Context Protocol-compatible JSON-RPC tools.

You own:

- MCP tool definitions
- typed retrieval APIs
- context injection hooks
- CLI commands for search/context/feedback
- feedback events from agent usage
- integration contract between retrieval and clients

## 2. Domain Boundaries & Monitored Interfaces

You own:

```txt
src/mcp/server.ts
src/mcp/tools.ts
src/mcp/schemas.ts
src/cli/search.ts
src/cli/context.ts
src/cli/feedback.ts
src/context/builder.ts
```

You may modify:

```txt
src/cli/index.ts
src/retrieval/hybrid-engine.ts
src/storage/store.ts
src/core/types.ts
```

You must expose MCP tools:

```txt
termyte.search
termyte.context
termyte.get_trace
termyte.get_observation
termyte.get_memory
termyte.feedback
termyte.explain
termyte.health
termyte.stats
```

You must expose CLI commands:

```txt
termyte search <query>
termyte context <query>
termyte feedback <memory-id> --event used
termyte trace <trace-id>
termyte memory <memory-id>
termyte stats --json
termyte health --json
```

Typed retrieval must support:

```txt
--type trace
--type observation
--type memory
--type summary
--type episode
--type all
```

## 3. Strict Architectural Constraints

- Must expose a standard MCP JSON-RPC-compatible interface.
- Must validate all incoming MCP tool arguments.
- Must not perform raw SQL directly inside MCP tool handlers; use store/retrieval service APIs.
- Must not mutate memory state on plain search.
- Must record `shown` feedback when context is injected.
- Must record `used` feedback only when explicitly requested by client/tool.
- Must support JSON output for automation.
- Must preserve existing CLI behavior where possible.
- Must keep local-first behavior; no external server dependency.
- Must return stable error objects for invalid arguments.

## 4. Step-by-Step Implementation Checklist

### Phase 1: Shared Schemas

Define input schemas for:

```ts
SearchInput
ContextInput
FeedbackInput
GetTraceInput
GetObservationInput
GetMemoryInput
ExplainInput
HealthInput
StatsInput
```

Example:

```ts
interface ContextInput {
  query: string;
  type?: "trace" | "observation" | "memory" | "summary" | "episode" | "all";
  files?: string[];
  sessionId?: string;
  tokenBudget?: number;
  limit?: number;
}
```

### Phase 2: Typed Retrieval Mapping

Implement:

```ts
function parseRetrievalType(type?: string): DocumentType[] | undefined;
```

Mapping:

```txt
all         -> undefined
trace       -> ['trace']
observation -> ['observation']
memory      -> ['memory']
summary     -> ['summary']
episode     -> ['episode']
```

Invalid type must return a structured error.

### Phase 3: MCP Tools

Implement `termyte.search`.

Response shape:

```json
{
  "results": [
    {
      "id": "memory:abc",
      "type": "memory",
      "score": 0.91,
      "content": "...",
      "files": ["src/storage/store.ts"],
      "confidence": 0.87,
      "importance": 0.74,
      "provenance": ["trace:t1", "observation:o2"]
    }
  ]
}
```

Implement `termyte.context`.

Response shape:

```json
{
  "markdown": "## Termyte Retrieved Memory\n...",
  "selectedIds": ["memory:abc"],
  "estimatedTokens": 1280,
  "contextInjectionId": "ctx_123"
}
```

Implement `termyte.feedback`.

Input:

```json
{
  "id": "memory:abc",
  "event": "used",
  "contextInjectionId": "ctx_123"
}
```

Implement `termyte.explain`.

It must return:

```json
{
  "id": "memory:abc",
  "state": "active",
  "sourceTraces": [],
  "sourceObservations": [],
  "edges": [],
  "feedback": [],
  "lastUpdated": 123456789
}
```

### Phase 4: CLI Commands

Add:

```txt
termyte search "query" --type memory --json
termyte context "query" --type all --token-budget 4000
termyte feedback memory:abc --event used --context-injection-id ctx_123
```

Human output should be readable.

JSON output should be stable and testable.

### Phase 5: Context Injection Feedback

When `context` is generated:

- call retrieval engine;
- persist `context_injections`;
- record `shown` feedback for selected memory documents;
- return `contextInjectionId`.

Do not record `used` automatically.

### Phase 6: Health and Stats

Expose:

```json
{
  "database": "ok",
  "jobs": {
    "pending": 12,
    "leased": 1,
    "failed": 2,
    "dead": 0
  },
  "documents": {
    "total": 482,
    "embedded": 470,
    "missingEmbeddings": 12
  },
  "retrieval": {
    "sqliteVecAvailable": true,
    "ftsAvailable": true
  }
}
```

## 5. Expected Output & Testing Criteria

Tests must cover:

- MCP argument validation
- typed retrieval mapping
- invalid type error
- search does not mutate feedback
- context records `shown` feedback
- explicit feedback records `used`
- CLI `--json` output is valid JSON
- context respects token budget
- explain returns provenance and edges
- health reports queue depth
- stats handles empty database

Acceptance criteria:

```txt
npm run typecheck passes
npm test passes
```
