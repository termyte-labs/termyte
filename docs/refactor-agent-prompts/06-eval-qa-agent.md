# Eval/QA Agent Prompt

## 1. Target Role & Objective

You are the QA/Backend Hybrid Engineer responsible for Termyte’s local benchmark and fault-injection harness.

Your objective is to build a deterministic evaluation system that proves the refactored Termyte pipeline is reliable, crash-safe, and retrieval-quality-regression-safe.

You own:

- local benchmark harness
- deterministic regression corpus
- retrieval quality tests
- ingestion crash/fault-injection tests
- worker recovery tests
- benchmark CLI
- CI-friendly test fixtures

## 2. Domain Boundaries & Monitored Interfaces

You own:

```txt
test/fixtures/regression-corpus/
test/eval/
src/eval/harness.ts
src/eval/corpus.ts
src/eval/metrics.ts
src/eval/fault-injection.ts
src/cli/eval.ts
```

You may modify:

```txt
src/cli/index.ts
vitest.config.ts
package.json
test/mock-llm.ts
```

You must expose CLI:

```txt
termyte eval
termyte eval --json
termyte eval --suite retrieval
termyte eval --suite durability
termyte eval --suite lifecycle
```

You must expose metrics:

```ts
interface EvalReport {
  suite: string;
  passed: boolean;
  metrics: Record<string, number>;
  failures: EvalFailure[];
}
```

## 3. Strict Architectural Constraints

- Must be deterministic.
- Must not require network access.
- Must not call live LLM APIs.
- Must not call live embedding APIs.
- Must use fixed mock LLM responses.
- Must use deterministic fixed embeddings.
- Must run on Windows.
- Must integrate with Vitest.
- Must test crash recovery using controlled fault injection, not random sleeps.
- Must produce JSON suitable for CI or future benchmark comparison.
- Must not depend on competitor repos.

## 4. Step-by-Step Implementation Checklist

### Phase 1: Regression Corpus

Create fixture corpus with at least 20 synthetic traces covering:

```txt
storage migration decision
sqlite-vec retrieval decision
failed embedding retry
memory supersession
conflicting coding convention
file-specific implementation detail
user preference
project architecture decision
deprecated approach
task state update
```

Each fixture must include:

```json
{
  "id": "case_sqlite_vec_001",
  "trace": {},
  "expectedObservations": [],
  "expectedMemories": [],
  "queries": [
    {
      "query": "How should vector search work?",
      "expectedDocIds": ["memory:sqlite_vec_decision"],
      "expectedKeywords": ["sqlite-vec", "vector"]
    }
  ]
}
```

### Phase 2: Fixed Embeddings

Implement deterministic embeddings:

```ts
class FixedEmbeddingsProvider {
  async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(16);

    for (let i = 0; i < text.length; i++) {
      const bucket = i % vector.length;
      vector[bucket] += text.charCodeAt(i) / 255;
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;

    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i] / norm;
    }

    return vector;
  }
}
```

### Phase 3: Mock LLM

Extend or create deterministic `MockLLM`.

It must support:

```ts
mockLLM.setResponseForTrace(traceId, xml);
mockLLM.setResponseSequence([...xml]);
mockLLM.throwOnCall(n, new Error("timeout"));
```

Must support malformed XML cases.

### Phase 4: Retrieval Metrics

Implement:

```ts
recallAtK(results, expectedIds, k)
mrr(results, expectedIds)
precisionAtK(results, expectedIds, k)
```

Required thresholds for local corpus:

```txt
Recall@5 >= 0.85
MRR >= 0.70
Precision@5 >= 0.50
```

### Phase 5: Durability Fault Injection

Implement controlled failure points:

```ts
type FaultPoint =
  | "after_observation_insert"
  | "before_observation_embedding"
  | "after_observation_embedding"
  | "before_memory_insert"
  | "after_memory_insert"
  | "before_memory_embedding"
  | "after_memory_embedding";
```

The harness must simulate:

- worker crash after observation insert;
- embedding timeout;
- malformed LLM XML;
- duplicate trace ingestion;
- expired job lease;
- process restart via new store instance.

Expected invariant:

```txt
After rerunning worker until idle:
  no valid trace is permanently lost;
  failed work is either completed or visible in dead-letter queue;
  no observation is marked indexed without embedding/index entry;
  no memory is active without embedding/index entry;
```

### Phase 6: Lifecycle Evaluation

Create tests for:

- stale memory decay
- used memory reinforcement
- duplicate memory supersession
- contradictory memory conflict state
- retrieval excludes superseded memory by default
- explain endpoint still shows superseded provenance

### Phase 7: CLI

Implement:

```txt
termyte eval --suite retrieval --json
```

JSON output:

```json
{
  "suite": "retrieval",
  "passed": true,
  "metrics": {
    "recallAt5": 0.9,
    "mrr": 0.78,
    "precisionAt5": 0.56
  },
  "failures": []
}
```

Human output should show:

```txt
Retrieval Eval
Recall@5: 0.90
MRR: 0.78
Precision@5: 0.56
PASS
```

## 5. Expected Output & Testing Criteria

Tests must cover:

- corpus loads correctly
- fixed embeddings are deterministic
- mock LLM response routing works
- retrieval metrics compute correctly
- eval CLI emits valid JSON
- fault injection after observation insert recovers
- embedding timeout retries then succeeds
- repeated embedding timeout creates dead-letter job
- malformed XML creates failed/dead job with readable error
- duplicate ingestion does not create duplicate jobs
- lifecycle eval catches supersession behavior
- all suites can run independently

Acceptance criteria:

```txt
npm run typecheck passes
npm test passes
termyte eval --json returns passed=true on deterministic corpus
```
