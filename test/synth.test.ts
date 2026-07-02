import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { FakeAdapter } from "../src/synth/fake.js";
import { Batcher } from "../src/synth/batcher.js";
import { buildBatchPrompt } from "../src/synth/prompts.js";
import { Lock } from "../src/synth/lock.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dbCtx: DatabaseContext;
let store: Store;

beforeEach(() => {
  dbCtx = openDatabase(":memory:");
  store = new Store(dbCtx);
});

function seedTraces(count: number, project = "test") {
  store.upsertSession("s1", project, "github.com/test/repo", "/work");
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = store.insertTrace({
      session_id: "s1",
      timestamp: Date.now() + i,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: `src/file${i}.ts` },
      tool_output: "ok",
      files_read: [`src/file${i}.ts`],
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });
    out.push(t);
  }
  return out;
}

describe("synth prompts", () => {
  it("buildBatchPrompt wraps every trace in a <trace> block", () => {
    const prompt = buildBatchPrompt([
      { id: 1, tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_output: "x", user_prompt: null, timestamp: 1700000000000 },
    ]);
    expect(prompt).toContain("<trace>");
    expect(prompt).toContain("<id>1</id>");
    expect(prompt).toContain("<tool>Read</tool>");
  });

  it("buildBatchPrompt returns a skip-summary hint on empty input", () => {
    expect(buildBatchPrompt([])).toContain("<skip_summary />");
  });
});

describe("Lock", () => {
  it("acquires and releases a lock file", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-lock-"));
    try {
      const path = join(dir, "synth.lock");
      const lock = Lock.acquire(path, { pid: process.pid, startedAt: Date.now(), host: "test" });
      expect(existsSync(path)).toBe(true);
      lock.release();
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-acquires a stale lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-lock-"));
    try {
      const path = join(dir, "synth.lock");
      // Write a lock owned by a dead PID (very high number, never alive).
      writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: 0, host: "dead" }));
      const lock = Lock.acquire(path, { pid: process.pid, startedAt: Date.now(), host: "test" });
      expect(readFileSync(path, "utf-8")).toContain(`"pid":${process.pid}`);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a live lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-lock-"));
    try {
      const path = join(dir, "synth.lock");
      const a = Lock.acquire(path, { pid: process.pid, startedAt: Date.now(), host: "test" });
      try {
        expect(() => Lock.acquire(path, { pid: process.pid, startedAt: Date.now() + 1, host: "x" }))
          .toThrow(/already running/);
      } finally { a.release(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Batcher", () => {
  it("writes observations from a fake adapter's response", async () => {
    seedTraces(3);
    const adapter = new FakeAdapter();
    adapter.setResponse(`<observation>
  <type>fact</type>
  <title>Project uses src/file0.ts</title>
  <description>Read of src/file0.ts succeeded.</description>
  <files_read><file>src/file0.ts</file></files_read>
</observation>`);
    const batcher = new Batcher(store, adapter);
    const result = await batcher.runOnce({ batchSize: 5 });
    expect(result.batches).toBe(1);
    expect(result.tracesRead).toBe(3);
    expect(result.observationsWritten).toBe(1);
    const obs = store.getObservationsForSession("s1");
    expect(obs.length).toBe(1);
    expect(obs[0]!.title).toBe("Project uses src/file0.ts");
    expect(obs[0]!.processed_at).toBeNull();
    expect(obs[0]!.lifecycle_state).toBe("awaiting_embedding");
    const job = store.getDB().prepare(
      `SELECT state FROM jobs WHERE kind = 'embed_observation' AND subject_id = ?`
    ).get(String(obs[0]!.id)) as { state: string };
    expect(job.state).toBe("pending");
    // Durable completion owns processed_at; synth must leave traces pending.
    expect(store.getUnprocessedTraces(10).length).toBe(3);
    store.close();
  });

  it("marks traces processed even when adapter returns <skip_summary />", async () => {
    seedTraces(2);
    const adapter = new FakeAdapter();
    adapter.setResponse(`<skip_summary />`);
    const batcher = new Batcher(store, adapter);
    const result = await batcher.runOnce({ batchSize: 5 });
    expect(result.observationsWritten).toBe(0);
    expect(store.getUnprocessedTraces(10).length).toBe(0);
    store.close();
  });

  it("caps batches per run", async () => {
    seedTraces(20);
    const adapter = new FakeAdapter();
    adapter.setResponse(`<skip_summary />`);
    const batcher = new Batcher(store, adapter);
    const result = await batcher.runOnce({ batchSize: 5, maxBatches: 2 });
    expect(result.batches).toBe(2);
    expect(result.tracesRead).toBe(10);
    expect(store.getUnprocessedTraces(10).length).toBe(10);
    store.close();
  });

  it("bails out on the first failed batch", async () => {
    seedTraces(10);
    const adapter = new FakeAdapter();
    adapter.nextError = { reason: "rate_limited", message: "stop" };
    const batcher = new Batcher(store, adapter);
    const result = await batcher.runOnce({ batchSize: 5, maxBatches: 5 });
    expect(result.lastError?.reason).toBe("rate_limited");
    expect(result.batches).toBe(0);
    // Failed batch leaves traces unprocessed so a future run can retry.
    expect(store.getUnprocessedTraces(10).length).toBe(10);
    store.close();
  });

  it("scopes to a single session when asked", async () => {
    store.upsertSession("s1", "p", "r", "/w");
    store.upsertSession("s2", "p", "r", "/w");
    for (let i = 0; i < 3; i++) {
      store.insertTrace({ session_id: "s1", timestamp: i, event_type: "tool_use", tool_name: "Read", tool_input: null, tool_output: null, files_read: null, files_modified: null, user_prompt: null, final_response: null });
      store.insertTrace({ session_id: "s2", timestamp: 100 + i, event_type: "tool_use", tool_name: "Read", tool_input: null, tool_output: null, files_read: null, files_modified: null, user_prompt: null, final_response: null });
    }
    const adapter = new FakeAdapter();
    adapter.setResponse(`<skip_summary />`);
    const batcher = new Batcher(store, adapter);
    const result = await batcher.runOnce({ batchSize: 50, sessionId: "s1" });
    expect(result.tracesRead).toBe(3);
    expect(store.getUnprocessedTracesForSession("s2").length).toBe(3);
    store.close();
  });

  it("writes multiple observations from a single response", async () => {
    seedTraces(2);
    const adapter = new FakeAdapter();
    adapter.setResponse(`<observation>
  <type>fact</type>
  <title>One</title>
  <description>First fact.</description>
</observation>
<observation>
  <type>warning</type>
  <title>Two</title>
  <description>Beware.</description>
</observation>`);
    const batcher = new Batcher(store, adapter);
    const result = await batcher.runOnce({ batchSize: 5 });
    expect(result.observationsWritten).toBe(2);
    const obs = store.getObservationsForSession("s1");
    expect(obs.length).toBe(2);
    // getObservationsForSession returns DESC by created_at, so the
    // "Two" observation (inserted second) comes first.
    expect(obs[0]!.type).toBe("warning");
    expect(obs[1]!.type).toBe("fact");
    store.close();
  });
});

describe("Adapter resolution", () => {
  it("createAdapter throws for the not-yet-implemented cursor adapter", async () => {
    const { createAdapter } = await import("../src/synth/index.js");
    expect(() => createAdapter("cursor")).toThrow(/not yet supported/);
  });

  it("createAdapter returns a FakeAdapter for the fake id", async () => {
    const { createAdapter } = await import("../src/synth/index.js");
    const a = createAdapter("fake");
    expect(a.id).toBe("fake");
    expect(await a.isAvailable()).toBe(true);
  });
});
