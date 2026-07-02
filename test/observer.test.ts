import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { Observer } from "../src/observer/pipeline.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import type { EmbeddingsProvider } from "../src/retrieval/embeddings.js";
import { MockLLM } from "./mock-llm.js";

let ctx: DatabaseContext;

class FixedEmbeddings implements EmbeddingsProvider {
  readonly dimensions = 4;
  async embed(): Promise<Float32Array> {
    return new Float32Array([1, 0, 0, 0]);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(() => this.embed()));
  }
}

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

function insertTrace(store: Store) {
  store.upsertSession("s1", "demo", "r1", "/w");
  return store.insertTrace({
    session_id: "s1", timestamp: 1, event_type: "tool_use",
    tool_name: "Read", tool_input: null, tool_output: null,
    files_read: null, files_modified: null, user_prompt: null, final_response: null,
  });
}

describe("Observer durable compatibility facade", () => {
  it("enqueue persists a job without invoking the LLM", () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm, embeddings: new FixedEmbeddings() });
    const trace = insertTrace(store);

    observer.enqueue(trace);

    expect(llm.calls).toHaveLength(0);
    expect(store.getTrace(trace.id)!.pipeline_state).toBe("observation_pending");
    const job = store.getDB().prepare(
      `SELECT state FROM jobs WHERE kind = 'extract_observation' AND subject_id = ?`
    ).get(String(trace.id)) as { state: string };
    expect(job.state).toBe("pending");
    expect(store.getTrace(trace.id)!.processed_at).toBeNull();
    store.close();
  });

  it("flush executes the complete pipeline under job leases", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponses([
      `<observation><type>fact</type><title>Observed</title></observation>`,
      `<observation><type>fact</type><title>Remembered</title></observation>`,
    ]);
    const observer = new Observer({ store, llm, embeddings: new FixedEmbeddings() });
    const trace = insertTrace(store);

    observer.enqueue(trace);
    await observer.flush();

    const observation = store.getRecentObservations(1)[0]!;
    const memory = store.getRecentMemories(1)[0]!;
    expect(observation.processed_at).not.toBeNull();
    expect(memory.lifecycle_state).toBe("active");
    expect(memory.embedding).not.toBeNull();
    expect(store.getTrace(trace.id)!.processed_at).not.toBeNull();
    store.close();
  });

  it("valid skip is the only extraction path that completes without an embedding", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<skip_summary />`);
    const observer = new Observer({ store, llm, embeddings: new FixedEmbeddings() });
    const trace = insertTrace(store);

    observer.enqueue(trace);
    await observer.flush();

    expect(store.getRecentObservations()).toHaveLength(0);
    expect(store.getTrace(trace.id)!.processed_at).not.toBeNull();
    store.close();
  });

  it("summary requests are durable jobs and do not invoke the LLM inline", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm, embeddings: new FixedEmbeddings() });
    insertTrace(store);

    await observer.generateSummary("s1", {
      user_prompts: [], final_response: null, files_modified: [],
    });

    expect(llm.calls).toHaveLength(0);
    const job = store.getDB().prepare(
      `SELECT state FROM jobs WHERE kind = 'update_summary' AND subject_id = 's1'`
    ).get() as { state: string };
    expect(job.state).toBe("pending");
    store.close();
  });
});
