import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { MemoryPipeline } from "../src/pipeline/memory-pipeline.js";
import type { EmbeddingsProvider } from "../src/retrieval/embeddings.js";
import { MockLLM } from "./mock-llm.js";

let ctx: DatabaseContext;
let store: Store;
let llm: MockLLM;
let embeddings: MockEmbeddingsProvider;
let pipeline: MemoryPipeline;

class MockEmbeddingsProvider implements EmbeddingsProvider {
  readonly dimensions = 4;
  calls = 0;
  shouldThrow = false;

  async embed(text: string): Promise<Float32Array> {
    this.calls++;
    if (this.shouldThrow) throw new Error("embedding timeout");
    const vector = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i++) vector[i % this.dimensions]! += text.charCodeAt(i);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

beforeEach(() => {
  ctx = openDatabase(":memory:");
  store = new Store(ctx);
  llm = new MockLLM();
  embeddings = new MockEmbeddingsProvider();
  pipeline = new MemoryPipeline({ store, llm, embeddings });
});

describe("MemoryPipeline durable processing", () => {
  it("does not mark an observation indexed or trace processed when embedding fails", async () => {
    store.upsertSession("s1", "demo", "r1", "/w");
    const trace = store.insertTrace({
      session_id: "s1",
      timestamp: 1,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_output: "content",
      files_read: ["src/a.ts"],
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });

    llm.setResponse(`<observation>
      <type>fact</type>
      <title>Observed fact</title>
      <description>Important fact.</description>
      <files_read><file>src/a.ts</file></files_read>
    </observation>`);

    pipeline.ingestTrace(trace.id);
    await pipeline.runOnce("worker-1");

    embeddings.shouldThrow = true;
    await pipeline.runOnce("worker-1");

    const observation = store.getRecentObservations(1)[0]!;
    expect(observation.lifecycle_state).toBe("awaiting_embedding");
    expect(observation.processed_at).toBeNull();
    expect(store.getTrace(trace.id)!.processed_at).toBeNull();
    expect(pipeline.getQueueStats().failed).toBe(1);
  });

  it("marks trace processed only after memory is active and searchable", async () => {
    store.upsertSession("s1", "demo", "r1", "/w");
    const trace = store.insertTrace({
      session_id: "s1",
      timestamp: 1,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_output: "content",
      files_read: ["src/a.ts"],
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });

    llm.setResponses([
      `<observation>
        <type>fact</type>
        <title>Observed fact</title>
        <description>Important fact.</description>
        <files_read><file>src/a.ts</file></files_read>
      </observation>`,
      `<observation>
        <type>fact</type>
        <title>Consolidated fact</title>
        <description>Important fact should be remembered.</description>
      </observation>`,
    ]);

    pipeline.ingestTrace(trace.id);
    const processed = await pipeline.runUntilIdle("worker-1", { maxJobs: 10 });

    expect(processed).toBe(6);

    const observation = store.getRecentObservations(1)[0]!;
    expect(observation.lifecycle_state).toBe("indexed");
    expect(observation.processed_at).not.toBeNull();

    const memory = store.getRecentMemories(1)[0]!;
    expect(memory.lifecycle_state).toBe("active");
    expect(memory.embedding).not.toBeNull();

    const document = store.getDB().prepare(
      `SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL`,
    ).get(`memory:${memory.id}`);
    expect(document).toBeTruthy();

    const updatedTrace = store.getTrace(trace.id)!;
    expect(updatedTrace.processed_at).not.toBeNull();
    expect(updatedTrace.pipeline_state).toBe("memory_ready");
  });

  it("enqueues unprocessed traces idempotently for the worker path", () => {
    store.upsertSession("s1", "demo", "r1", "/w");
    const trace = store.insertTrace({
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

    expect(pipeline.enqueueUnprocessedTraces()).toBe(1);
    expect(pipeline.enqueueUnprocessedTraces()).toBe(1);
    expect(pipeline.getQueueStats().pending).toBe(1);
    expect(store.getTrace(trace.id)!.pipeline_state).toBe("observation_pending");
  });
});
