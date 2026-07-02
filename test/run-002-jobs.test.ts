import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { MemoryPipeline } from "../src/pipeline/memory-pipeline.js";
import { MockLLM } from "./mock-llm.js";

class MockEmbeddingsProvider implements import("../src/retrieval/embeddings.js").EmbeddingsProvider {
  readonly dimensions = 4;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i++) v[i % this.dimensions]! += text.charCodeAt(i);
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

let ctx: DatabaseContext;
let store: Store;
let llm: MockLLM;
let embeddings: MockEmbeddingsProvider;
let pipeline: MemoryPipeline;

beforeEach(() => {
  ctx = openDatabase(":memory:");
  store = new Store(ctx);
  llm = new MockLLM();
  embeddings = new MockEmbeddingsProvider();
  pipeline = new MemoryPipeline({ store, llm, embeddings });
});

function seedTrace(sessionId = "s1", cwd = "/repo") {
  store.upsertSession(sessionId, "repo", "r1", cwd);
  return store.insertTrace({
    session_id: sessionId,
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
}

describe("RUN-002 dedupe_memories handler", () => {
  it("marks an exact duplicate superseded with an edge and omits it from documents", async () => {
    const trace = seedTrace();
    // One trace extracts two identical observations, each consolidating to
    // the same memory content -> the second is a canonical-key duplicate.
    llm.setResponses([
      `<observation><type>fact</type><title>Same fact</title><description>Dedupe me.</description><files_read><file>src/a.ts</file></files_read></observation>
       <observation><type>fact</type><title>Same fact</title><description>Dedupe me.</description><files_read><file>src/a.ts</file></files_read></observation>`,
      `<observation><type>fact</type><title>Same fact</title><description>Dedupe me.</description></observation>`,
      `<observation><type>fact</type><title>Same fact</title><description>Dedupe me.</description></observation>`,
      `<skip_summary />`,
    ]);

    pipeline.ingestTrace(trace.id);
    await pipeline.runUntilIdle("w", { maxJobs: 30 });

    const memories = store.getRecentMemories(10);
    expect(memories.length).toBe(2);
    const active = memories.filter((m) => m.lifecycle_state === "active");
    const superseded = memories.filter((m) => m.lifecycle_state === "superseded");
    expect(active.length).toBe(1);
    expect(superseded.length).toBe(1);
    expect(superseded[0]!.superseded_by).toBe(active[0]!.id);

    const edges = store.getMemoryEdges(active[0]!.id);
    expect(edges.length).toBe(1);
    expect(["duplicates", "supersedes"]).toContain(edges[0]!.edge_type);

    // The loser's search document is soft-deleted.
    const loserDoc = store
      .getDB()
      .prepare(`SELECT deleted_at FROM documents WHERE id = ?`)
      .get(`memory:${superseded[0]!.id}`) as { deleted_at: number | null };
    expect(loserDoc.deleted_at).not.toBeNull();
  });

  it("is idempotent: re-running the dedupe job does not duplicate edges or change state", async () => {
    const trace = seedTrace();
    llm.setResponses([
      `<observation><type>fact</type><title>Dup</title><description>Same.</description></observation>`,
      `<observation><type>fact</type><title>Dup</title><description>Same.</description></observation>`,
      `<skip_summary />`,
    ]);
    pipeline.ingestTrace(trace.id);
    await pipeline.runUntilIdle("w", { maxJobs: 20 });

    const beforeEdges = (store.getDB().prepare(`SELECT COUNT(*) c FROM memory_edges`).get() as { c: number }).c;
    const beforeSuperseded = (store.getDB().prepare(`SELECT COUNT(*) c FROM memories WHERE lifecycle_state='superseded'`).get() as { c: number }).c;

    // Re-enqueue a dedupe job for the active memory and run again.
    const active = store.getRecentMemories(10).find((m) => m.lifecycle_state === "active")!;
    store.getDB()
      .prepare(`INSERT OR IGNORE INTO jobs (id,kind,subject_type,subject_id,state,attempt_count,max_attempts,next_run_at,created_at,updated_at) VALUES ('manual-dedupe','dedupe_memories','memory',?,'pending',0,5,0,0,0)`)
      .run(active.id);
    await pipeline.runUntilIdle("w", { maxJobs: 5 });

    const afterEdges = (store.getDB().prepare(`SELECT COUNT(*) c FROM memory_edges`).get() as { c: number }).c;
    const afterSuperseded = (store.getDB().prepare(`SELECT COUNT(*) c FROM memories WHERE lifecycle_state='superseded'`).get() as { c: number }).c;
    expect(afterEdges).toBe(beforeEdges);
    expect(afterSuperseded).toBe(beforeSuperseded);
  });

  it("leaves non-duplicate active memories alone", async () => {
    const trace = seedTrace();
    llm.setResponses([
      `<observation><type>fact</type><title>Unique A</title><description>Distinct content A.</description></observation>`,
      `<observation><type>warning</type><title>Unique B</title><description>Distinct content B.</description></observation>`,
      `<skip_summary />`,
    ]);
    pipeline.ingestTrace(trace.id);
    await pipeline.runUntilIdle("w", { maxJobs: 20 });

    const memories = store.getRecentMemories(10);
    expect(memories.every((m) => m.lifecycle_state === "active")).toBe(true);
    expect((store.getDB().prepare(`SELECT COUNT(*) c FROM memory_edges`).get() as { c: number }).c).toBe(0);
  });
});

describe("RUN-002 update_summary handler", () => {
  it("writes exactly one latest summary per session and is idempotent on retry", async () => {
    const trace = seedTrace("sum-session", "/repo");
    store.getDB().prepare(`UPDATE traces SET user_prompt = ?, final_response = ? WHERE id = ?`).run("fix the bug", "done", trace.id);

    const summaryXml = `<summary><summary_text>Fixed the bug by trimming tokens.</summary_text><key_changes><change>src/a.ts</change></key_changes><key_learnings><learning>trim before validation</learning></key_learnings></summary>`;
    llm.setResponses([
      `<observation><type>fact</type><title>Did work</title><description>Made a change.</description></observation>`,
      `<observation><type>fact</type><title>Memory</title><description>Resulted memory.</description></observation>`,
      // update_summary runs after the memory embeds; queue a summary response.
      summaryXml,
      summaryXml, // a retry would consume this
    ]);

    pipeline.ingestTrace(trace.id);
    await pipeline.runUntilIdle("w", { maxJobs: 20 });

    const summary = store.getSummary("sum-session");
    expect(summary).not.toBeNull();
    expect(summary!.summary).toContain("Fixed the bug");

    const count = (store.getDB().prepare(`SELECT COUNT(*) c FROM summaries WHERE session_id = ?`).get("sum-session") as { c: number }).c;
    expect(count).toBe(1);
  });

  it("succeeds without writing a falsehood on <skip_summary/>", async () => {
    const trace = seedTrace("skip-session", "/repo");
    llm.setResponses([
      `<observation><type>fact</type><title>Did work</title><description>Made a change.</description></observation>`,
      `<observation><type>fact</type><title>Memory</title><description>Resulted memory.</description></observation>`,
      `<skip_summary />`,
    ]);
    pipeline.ingestTrace(trace.id);
    await pipeline.runUntilIdle("w", { maxJobs: 20 });
    expect(store.getSummary("skip-session")).toBeNull();
  });

  it("dead-letters a malformed summary instead of writing a falsehood", async () => {
    const trace = seedTrace("bad-summary", "/repo");
    llm.setResponses([
      `<observation><type>fact</type><title>Did work</title><description>Made a change.</description></observation>`,
      `<observation><type>fact</type><title>Memory</title><description>Resulted memory.</description></observation>`,
      `this is not valid xml`,
    ]);
    pipeline.ingestTrace(trace.id);
    await pipeline.runUntilIdle("w", { maxJobs: 20 });
    expect(store.getSummary("bad-summary")).toBeNull();
    const job = store.getDB().prepare(`SELECT state FROM jobs WHERE kind='update_summary' AND subject_id='bad-summary'`).get() as { state: string };
    expect(job.state).toBe("dead");
  });
});

describe("RUN-002 no silent job success", () => {
  it("an unsupported job kind dead-letters instead of silently succeeding", async () => {
    store.getDB()
      .prepare(`INSERT INTO jobs (id,kind,subject_type,subject_id,state,attempt_count,max_attempts,next_run_at,created_at,updated_at) VALUES ('bad','not_a_real_kind','trace','1','pending',0,1,0,0,0)`)
      .run();
    // A job must be claimed by max_attempts>=1; ensure attempt stays under max.
    await pipeline.runUntilIdle("w", { maxJobs: 5 });
    const job = store.getDB().prepare(`SELECT state, last_error FROM jobs WHERE id = 'bad'`).get() as { state: string; last_error: string | null };
    expect(job.state).toBe("dead");
    expect(job.last_error).toContain("Unsupported job kind");
  });
});