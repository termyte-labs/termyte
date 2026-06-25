import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, closeDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { Observer } from "../src/observer/pipeline.js";
import { MockLLM } from "./mock-llm.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { VectorSearch } from "../src/retrieval/vector.js";
import { HybridSearch } from "../src/retrieval/hybrid.js";
import { type EmbeddingsProvider } from "../src/retrieval/embeddings.js";
import { ContextBuilder } from "../src/context/builder.js";
import { HookRunner } from "../src/hooks/runner.js";

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

    // Step 1: capture a Claude Code PostToolUse event via the runner.
    await runner.processRaw("claude-code", {
      session_id: "s1",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "src/auth.ts" },
      tool_response: "ok",
      hook_event_name: "PostToolUse",
    });
    // The observer generates an observation off the mock LLM.
    llm.setResponse(`<observation>
      <type>bugfix</type>
      <title>Auth whitespace</title>
      <narrative>Trim tokens before validation.</narrative>
      <files_modified><file>src/auth.ts</file></files_modified>
    </observation>`);
    await observer.flush();

    // Step 2: verify the memory is in the store.
    const mems = store.getMemoriesForSession("s1");
    expect(mems.length).toBe(1);
    expect(mems[0]!.title).toBe("Auth whitespace");

    // Step 3: backfill embeddings (the observer kicks this off async,
    // but the deterministic embeddings provider is fast enough that we
    // can poll or just re-embed explicitly).
    for (const m of mems) {
      if (!m.embedding) {
        store.updateMemoryEmbedding(m.id, await embeddings.embed(m.title));
      }
    }

    // Step 4: hybrid search returns the memory.
    const fts = new FTSSearch(store);
    const vec = new VectorSearch(store);
    const hybrid = new HybridSearch({ fts, vector: vec, embeddings });
    const results = await hybrid.search({ query: "auth whitespace", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.title).toBe("Auth whitespace");
    expect(results[0]!.combined_score).toBeGreaterThan(0);

    // Step 5: context builder renders the project context.
    const builder = new ContextBuilder(store, hybrid);
    const ctxOut = await builder.build({ project: "work", query: "auth" });
    expect(ctxOut.text).toContain("Auth whitespace");
    expect(ctxOut.text).toContain("Memory Context for work");

    store.close();
  });

  it("recovers from a process crash: unprocessed traces are picked up on next start", async () => {
    // Simulate a previous run that crashed after writing a trace but
    // before the observer consumed it.
    const store = new Store(ctx);
    store.upsertSession("s1", "demo");
    store.insertTrace({
      session_id: "s1",
      timestamp: 1,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: null,
      tool_output: null,
      files_read: null,
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });
    expect(store.getUnprocessedTraces().length).toBe(1);

    // New run: the worker boots, processes the unprocessed trace.
    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>discovery</type>
      <title>Caught up</title>
    </observation>`);
    const observer = new Observer({ store, llm });
    const processed = await observer.processUnprocessedOnce();
    expect(processed).toBe(1);
    expect(store.getUnprocessedTraces().length).toBe(0);
    expect(store.getMemoriesForSession("s1")[0]!.title).toBe("Caught up");
    store.close();
  });
});
