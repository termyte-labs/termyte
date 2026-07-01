# Memory Lifecycle Agent Prompt

## 1. Target Role & Objective

You are the AI Systems Engineer responsible for Termyte’s Dynamic Memory Lifecycle.

Your objective is to transform memories from immutable terminal rows into evolving memory records with lifecycle state, decay scoring, feedback reinforcement, deduplication, contradiction handling, and supersession.

You own:

- memory state machine
- memory decay
- importance/confidence updates
- usage feedback hooks
- deduplication
- conflict detection
- supersession edges
- memory graph relationships

## 2. Domain Boundaries & Monitored Interfaces

You own:

```txt
src/lifecycle/decay.ts
src/lifecycle/feedback.ts
src/lifecycle/dedupe.ts
src/lifecycle/supersession.ts
src/lifecycle/relation-classifier.ts
src/storage/lifecycle.ts
src/storage/memory-edges.ts
```

You may modify:

```txt
src/storage/migrations.ts
src/storage/store.ts
src/core/types.ts
src/observer/pipeline.ts
src/pipeline/workers.ts
```

You must expose:

```ts
interface MemoryLifecycleService {
  applyDecayBatch(limit: number): number;
  recordFeedback(input: MemoryFeedbackInput): void;
  dedupeMemory(memoryId: string): DedupeResult;
  classifyRelations(memoryId: string): Promise<RelationResult[]>;
  supersedeMemory(input: SupersessionInput): void;
}
```

Required public state:

```ts
type MemoryState =
  | "active"
  | "stale"
  | "superseded"
  | "conflicted"
  | "deleted";

type MemoryEdgeType =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "duplicates"
  | "derived_from"
  | "related_to";
```

## 3. Strict Architectural Constraints

- Must preserve immutable source traces.
- Must never physically delete memories by default; use soft-delete state.
- Must record supersession as an edge, not by overwriting history.
- Must keep lifecycle decisions deterministic where possible.
- Must not compare every memory against every other memory.
- Must use canonical keys and vector-nearest candidates for dedupe scope.
- Must not use an LLM to score decay or feedback.
- LLM relation classification is allowed only after narrowing candidates.
- Must keep all lifecycle updates in SQLite transactions.
- Must expose enough metadata for retrieval and diagnostics modules.

## 4. Step-by-Step Implementation Checklist

### Phase 1: Schema

Add memory lifecycle fields:

```sql
ALTER TABLE memories ADD COLUMN state TEXT DEFAULT 'active';
ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER;
ALTER TABLE memories ADD COLUMN last_reinforced_at INTEGER;
ALTER TABLE memories ADD COLUMN decayed_score REAL NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN content_hash TEXT;
ALTER TABLE memories ADD COLUMN canonical_key TEXT;
ALTER TABLE memories ADD COLUMN superseded_by TEXT REFERENCES memories(id);
```

Create memory edges:

```sql
CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL REFERENCES memories(id),
  target_memory_id TEXT NOT NULL REFERENCES memories(id),
  edge_type TEXT NOT NULL CHECK (
    edge_type IN (
      'supports',
      'contradicts',
      'supersedes',
      'duplicates',
      'derived_from',
      'related_to'
    )
  ),
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  UNIQUE(source_memory_id, target_memory_id, edge_type)
);
```

Create feedback table:

```sql
CREATE TABLE IF NOT EXISTS memory_feedback (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  doc_id TEXT,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('shown', 'used', 'ignored', 'downranked', 'corrected')
  ),
  weight REAL NOT NULL,
  source TEXT NOT NULL,
  context_injection_id TEXT,
  created_at INTEGER NOT NULL
);
```

### Phase 2: Decay Algorithm

Implement:

```ts
function memoryDecayScore(memory: MemoryLifecycleRow, nowMs: number): number;
```

Formula:

```ts
score =
  0.34 * freshness +
  0.18 * accessFreshness +
  0.20 * importance +
  0.18 * confidence +
  0.10 * boundedUsageBoost;
```

Where:

```ts
freshness = 0.5 ** (ageDays / halfLifeDays)
accessFreshness = 0.5 ** (accessAgeDays / 45)
boundedUsageBoost = min(1, log1p(usageCount) / log(20))
```

Half-life by memory type:

```ts
const halfLifeDays = {
  preference: 180,
  project_convention: 120,
  decision: 90,
  fact: 45,
  task_state: 14,
  warning: 60,
  default: 45,
};
```

State transition:

```txt
if state in ('deleted', 'superseded') keep state
else if decayedScore < 0.22 state = 'stale'
else state = 'active'
```

### Phase 3: Feedback

Implement feedback events:

```ts
recordFeedback({
  memoryId,
  docId,
  eventType,
  weight,
  source,
  contextInjectionId,
});
```

Rules:

```txt
shown      -> importance +0.01
used       -> usage_count +1, importance +0.06, confidence +0.02, last_accessed_at now
ignored    -> importance -0.02
downranked -> importance -0.05
corrected  -> confidence -0.10, state conflicted if confidence < 0.3
```

Clamp all `importance` and `confidence` to `[0, 1]`.

If stale memory is used, reactivate it.

### Phase 4: Canonical Deduplication

Implement:

```ts
function canonicalMemoryKey(input: {
  type: string;
  content: string;
  files: string[];
}): string;
```

Normalization:

- lowercase
- compact whitespace
- normalize file paths
- replace ISO dates with `<date>`
- replace Git hashes with `<hash>`
- sort files

Deduplication rule:

```txt
same canonical_key
OR
same type AND fileOverlap >= 0.5 AND cosineSimilarity >= 0.92
```

### Phase 5: Supersession

Implement:

```ts
function supersedeMemory(input: {
  oldMemoryId: string;
  newMemoryId: string;
  confidence: number;
}): void;
```

Transaction must:

- insert `memory_edges` row with `edge_type = 'supersedes'`;
- set old memory `state = 'superseded'`;
- set old memory `superseded_by = newMemoryId`;
- soft-delete or downrank old document row from retrieval;
- keep source traces intact.

### Phase 6: Conflict Detection

Implement scoped relation classification.

Candidate narrowing:

```txt
new memory
  -> retrieve top 20 semantically similar active memories
  -> filter by same type or overlapping files
  -> deterministic duplicate check
  -> optional LLM relation classifier only for ambiguous candidates
```

Relation classifier output must be parsed into:

```ts
type RelationLabel =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "duplicates"
  | "unrelated";
```

On contradiction:

- insert `memory_edges` with `edge_type = 'contradicts'`;
- mark both memories `conflicted`;
- do not delete either memory.

## 5. Expected Output & Testing Criteria

Tests must cover:

- decay score decreases with age
- access frequency increases score
- stale memory reactivates when used
- importance/confidence clamping
- shown/used/ignored/downranked/corrected feedback
- canonical key normalizes dates/hashes/whitespace
- exact duplicate creates duplicate edge
- stronger new memory supersedes old memory
- contradiction marks both memories conflicted
- deleted and superseded memories do not reactivate from decay
- all lifecycle updates happen transactionally

Acceptance criteria:

```txt
npm run typecheck passes
npm test passes
```
