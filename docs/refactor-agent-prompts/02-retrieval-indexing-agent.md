# Retrieval/Indexing Agent Prompt

## 1. Target Role & Objective

You are the Search Engineer responsible for Termyte’s High-Precision Retrieval Engine.

Your objective is to replace naive BLOB-scanning vector search with native `sqlite-vec`, combine it with SQLite FTS5 keyword search, implement Reciprocal Rank Fusion, and produce deterministic token-budgeted context for MCP injection.

You own:

- sqlite-vec integration
- document retrieval corpus
- vector indexing
- FTS5 sparse search
- hybrid RRF ranking
- deterministic reranking
- context token packer

## 2. Domain Boundaries & Monitored Interfaces

You own these modules:

```txt
src/indexing/sqlite-vec-index.ts
src/indexing/document-indexer.ts
src/retrieval/hybrid-engine.ts
src/retrieval/reranker.ts
src/retrieval/token-packer.ts
src/retrieval/query.ts
src/storage/documents.ts
```

You may modify:

```txt
src/storage/migrations.ts
src/storage/store.ts
src/retrieval/fts.ts
src/retrieval/vector.ts
src/retrieval/hybrid.ts
src/context/builder.ts
```

You must expose:

```ts
interface DocumentIndexer {
  upsertDocument(input: UpsertDocumentInput): void;
  upsertEmbedding(input: UpsertEmbeddingInput): void;
  deleteDocument(docId: string): void;
}

interface HybridRetrievalEngine {
  retrieve(input: RetrievalQuery): Promise<RetrievalResult[]>;
  retrieveContext(input: RetrievalQuery): Promise<PackedContext>;
}

interface TokenBudgetPacker {
  pack(input: PackInput): PackedContext;
}
```

Required shared types:

```ts
type DocumentType =
  | "trace"
  | "observation"
  | "memory"
  | "summary"
  | "episode";

interface RetrievalQuery {
  text: string;
  files: string[];
  sessionId?: string;
  types?: DocumentType[];
  limit: number;
  tokenBudget: number;
  nowMs: number;
}
```

## 3. Strict Architectural Constraints

- Must use SQLite FTS5 for sparse search.
- Must use `sqlite-vec` for native vector search when available.
- Must not use external vector databases.
- Must not perform full table BLOB vector scans when sqlite-vec is available.
- Must gracefully degrade to FTS-only when embeddings or sqlite-vec are unavailable.
- Must preserve local-first single-database behavior.
- Must not depend on network calls in tests.
- Must keep context packing deterministic.
- Must not use an LLM for retrieval reranking in the core path.
- Must support typed retrieval: `trace`, `observation`, `memory`, `summary`, `episode`, `all`.

## 4. Step-by-Step Implementation Checklist

### Phase 1: Documents Table

Create normalized retrieval corpus:

```sql
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL CHECK (
    doc_type IN ('trace', 'observation', 'memory', 'summary', 'episode')
  ),
  source_id TEXT NOT NULL,
  session_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  recency_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(doc_type, source_id)
);
```

Create FTS table:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  content,
  files,
  tags,
  content='documents',
  content_rowid='rowid'
);
```

Add insert/update/delete triggers.

### Phase 2: sqlite-vec Integration

Implement:

```ts
class SqliteVecIndex {
  ensureTable(dimensions: number): void;
  upsert(docId: string, vector: Float32Array): void;
  search(vector: Float32Array, limit: number): VectorHit[];
}
```

Create vector table:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS document_vec_1536
USING vec0(
  doc_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);
```

Add metadata table:

```sql
CREATE TABLE IF NOT EXISTS document_embeddings (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_table TEXT NOT NULL,
  embedded_at INTEGER NOT NULL,
  embedding_hash TEXT NOT NULL
);
```

### Phase 3: Sparse Search

Implement FTS5 BM25 search:

```ts
searchSparse(input: {
  query: string;
  files: string[];
  types?: DocumentType[];
  limit: number;
}): SparseHit[];
```

Rules:

- lower BM25 is better;
- normalize score into 0–1;
- filter out `deleted_at IS NOT NULL`;
- filter by document type when provided;
- include file terms when query files are provided.

### Phase 4: Dense Search

Implement vector search:

```ts
searchDense(input: {
  embedding: Float32Array;
  types?: DocumentType[];
  limit: number;
}): DenseHit[];
```

Use sqlite-vec `MATCH`.

Hydrate document rows after vector search.

### Phase 5: RRF Fusion

Implement Reciprocal Rank Fusion:

```ts
function rrf(rank: number, k = 60): number {
  return 1 / (k + rank);
}
```

Fusion weights:

```ts
const weights = {
  dense: 1.0,
  sparse: 0.9,
  recent: 0.45,
  graph: 0.55,
  fileOverlap: 0.35,
};
```

Candidate limits:

```ts
const config = {
  sparseLimit: 80,
  denseLimit: 80,
  recentLimit: 30,
  finalCandidateLimit: 120,
  rerankedLimit: 40,
  packedContextLimit: 12,
  rrfK: 60,
};
```

### Phase 6: Deterministic Reranking

Implement:

```ts
function finalScore(candidate: Candidate, query: RetrievalQuery): number;
```

Formula:

```ts
score =
  0.32 * semanticScore +
  0.24 * sparseScore +
  0.14 * fileOverlapScore +
  0.10 * recencyScore +
  0.10 * importance +
  0.07 * confidence +
  0.03 * usageScore -
  conflictPenalty;
```

Recency:

```ts
function recencyScore(timestampMs: number, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - timestampMs) / 86_400_000);
  return Math.pow(0.5, ageDays / 30);
}
```

### Phase 7: Token-Budget Packer

Implement deterministic context packing:

```ts
class DeterministicTokenPacker {
  pack(input: {
    query: RetrievalQuery;
    candidates: RankedDocument[];
    tokenBudget: number;
  }): PackedContext;
}
```

Rules:

- reserve 250 tokens for header/provenance;
- never exceed requested token budget;
- prefer high score;
- reduce redundancy using MMR;
- preserve document IDs and provenance;
- trim long items rather than dropping all context;
- group by document type.

Use approximate token estimator:

```ts
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

## 5. Expected Output & Testing Criteria

Unit tests must cover:

- FTS document insert/update/delete trigger behavior
- sqlite-vec table creation when extension is available
- graceful FTS-only fallback when sqlite-vec unavailable
- dense search returns nearest document
- sparse search returns keyword match
- RRF ranks document found by both dense and sparse above one-source hits
- typed retrieval filters correctly
- deleted documents are excluded
- token packer never exceeds budget
- token packer includes provenance IDs
- redundant candidates are suppressed by MMR

Mock embeddings:

```ts
class FixedEmbeddings {
  async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(4);
    for (let i = 0; i < text.length; i++) {
      vector[i % 4] += text.charCodeAt(i);
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vector.length; i++) vector[i] = vector[i] / norm;
    return vector;
  }
}
```

Acceptance criteria:

```txt
npm run typecheck passes
npm test passes
```
