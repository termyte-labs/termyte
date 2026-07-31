import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { Observer } from "../src/context/observations/pipeline.js";
import { MockLLM } from "./mock-llm.js";
import { FTSSearch } from "../src/context/retrieval/fts.js";
import { VectorSearch } from "../src/context/retrieval/vector.js";
import { HybridSearch } from "../src/context/retrieval/hybrid.js";
import { type EmbeddingsProvider } from "../src/context/retrieval/embeddings.js";
import { ContextBuilder } from "../src/context/builder.js";
import { HookRunner } from "../src/agents/hooks/runner.js";

let ctx: DatabaseContext;

class FixedEmbeddings implements EmbeddingsProvider {
  readonly dimensions = 4;
  private cache = new Map<string, Float32Array>();

  async embed(text: string): Promise<Float32Array> {
    const cached = this.cache.get(text);
    if (cached) return cached;
    const v = new Float32Array(this.dimensions);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h * 16777619) >>> 0;
      v[i % this.dimensions]! += (h & 0xff) / 255 - 0.5;
    }
    let n = 0;
    for (let i = 0; i < this.dimensions; i++) n += v[i]! * v[i]!;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < this.dimensions; i++) v[i]! /= n;
    this.cache.set(text, v);
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

describe("Integration: capture -> observe -> store -> retrieve", () => {
  it("runs the full pipeline end-to-end", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const embeddings = new FixedEmbeddings();
    const observer = new Observer({ store, llm, embeddings });
    const runner = new HookRunner({ store, observer });

    // Step 1: capture a Claude Code tool use event.
    await runner.processRaw("claude-code", {
      session_id: "s1",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "src/auth.ts" },
      tool_response: "ok",
      hook_event_name: "PostToolUse",
    });

    // Step 2: the durable worker extracts, embeds, and consolidates.
    llm.setResponses([
      `<observation>
        <type>bugfix</type>
        <title>Auth whitespace</title>
        <description>Trim tokens before validation.</description>
        <files_modified><file>src/auth.ts</file></files_modified>
      </observation>`,
      `<observation>
        <type>bugfix</type>
        <title>Auth whitespace consolidated</title>
        <description>Tokens trimmed before validation.</description>
      </observation>`,
    ]);
    await observer.flush();

    // Verify observation
    const obs = store.getRecentObservations(10);
    expect(obs.length).toBe(1);
    expect(obs[0]!.title).toBe("Auth whitespace");

    const mems = store.getRecentMemories(10);
    expect(mems.length).toBe(1);
    expect(mems[0]!.title).toBe("Auth whitespace consolidated");

    // Step 3: hybrid search returns the memory
    const fts = new FTSSearch(store);
    const vec = new VectorSearch(store);
    const hybrid = new HybridSearch({ fts, vector: vec, embeddings });
    const results = await hybrid.search({ query: "auth whitespace", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.title).toBe("Auth whitespace consolidated");
    expect(results[0]!.combined_score).toBeGreaterThan(0);

    // Step 4: context builder renders repo context
    const builder = new ContextBuilder(store, hybrid);
    const ctxOut = await builder.build({ repo_id: "unknown", query: "auth" });
    expect(ctxOut.text).toContain("Auth whitespace consolidated");
    expect(ctxOut.text).toContain("Termyte Context for");

    store.close();
  });

  it("recovers from a process crash: unprocessed traces are picked up on next start", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "r1", "/w");
    store.insertTrace({
      session_id: "s1", timestamp: 1, event_type: "tool_use",
      tool_name: "Read", tool_input: null, tool_output: null,
      files_read: null, files_modified: null, user_prompt: null, final_response: null,
    });
    expect(store.getUnprocessedTraces().length).toBe(1);

    // New run boots, processes unprocessed trace through both stages.
    const llm = new MockLLM();
    // Stage 1: observation, Stage 2: memory
    llm.setResponses([
      `<observation><type>fact</type><title>Caught up</title></observation>`,
      `<observation><type>fact</type><title>Consolidated caught up</title></observation>`,
    ]);
    const observer = new Observer({ store, llm, embeddings: new FixedEmbeddings() });
    const processed = await observer.processUnprocessedOnce();
    expect(processed).toBe(1);
    expect(store.getUnprocessedTraces().length).toBe(0);
    expect(store.getRecentObservations(10)[0]!.title).toBe("Caught up");
    expect(store.getRecentMemories(10)[0]!.title).toBe("Consolidated caught up");
    store.close();
  });

  it("memory provenance traces back to original trace", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "r1", "/w");

    const llm = new MockLLM();
    const observer = new Observer({ store, llm, embeddings: new FixedEmbeddings() });
    const runner = new HookRunner({ store, observer });

    // Capture
    await runner.processRaw("claude-code", {
      session_id: "s1", cwd: "/work",
      tool_name: "Bash", tool_input: { command: "npm test" },
      tool_response: "all tests pass",
    });

    llm.setResponses([
      `<observation>
        <type>procedure</type>
        <title>Run tests with npm test</title>
        <description>Use npm test to run the test suite.</description>
      </observation>`,
      `<observation>
        <type>procedure</type>
        <title>Testing procedure</title>
        <description>Run npm test to execute tests.</description>
      </observation>`,
    ]);
    await observer.flush();

    const obs = store.getRecentObservations(10);
    expect(obs.length).toBe(1);
    // Observation references its source traces
    expect(obs[0]!.source_trace_ids.length).toBe(1);

    const mems = store.getRecentMemories(10);
    expect(mems.length).toBe(1);
    // Memory references its source observations
    expect(mems[0]!.source_observation_ids).toEqual([obs[0]!.id]);
    // Memory also has transitive trace provenance
    expect(mems[0]!.source_trace_ids.length).toBe(1);

    store.close();
  });
});