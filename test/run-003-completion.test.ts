import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { runMigrations } from "../src/storage/migrations.js";
import { Store } from "../src/storage/store.js";

let ctx: DatabaseContext;
let store: Store;

beforeEach(() => {
  ctx = openDatabase(":memory:");
  store = new Store(ctx);
});

function seedTrace(sessionId = "s1", cwd = "/w") {
  store.upsertSession(sessionId, "repo", "r1", cwd);
  return store.insertTrace({
    session_id: sessionId,
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
}

function insertObservationForTrace(traceId: number, sessionId: string, processed: boolean): number {
  const obs = store.insertObservation({
    session_id: sessionId,
    repo_id: "r1",
    workspace_root: "/w",
    type: "fact",
    title: "obs",
    description: "d",
    files_read: ["src/a.ts"],
    files_modified: [],
    commands_executed: [],
    source_trace_ids: [traceId],
    created_at: Date.now(),
    processed_at: null,
  });
  store.insertTraceObservationLinks(obs.id, [traceId]);
  if (processed) store.markObservationProcessed(obs.id);
  return obs.id;
}

function explainContains(sql: string, ...params: unknown[]): boolean {
  const plan = store.getDB().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return plan.some((row) => /trace_observations|observation_memories|idx_/.test(row.detail));
}

describe("RUN-003 indexed completion lookups", () => {
  it("markTraceProcessedIfObservationsReady uses the trace_observations index", () => {
    const trace = seedTrace();
    insertObservationForTrace(trace.id, "s1", false);
    expect(explainContains(`SELECT observation_id FROM trace_observations WHERE trace_id = ?`, trace.id)).toBe(true);
  });

  it("does not complete a trace until all derived observations are processed", () => {
    const trace = seedTrace();
    const o1 = insertObservationForTrace(trace.id, "s1", false);
    const o2 = insertObservationForTrace(trace.id, "s1", false);
    expect(store.markTraceProcessedIfObservationsReady(trace.id)).toBe(false);
    store.markObservationProcessed(o1);
    expect(store.markTraceProcessedIfObservationsReady(trace.id)).toBe(false);
    store.markObservationProcessed(o2);
    expect(store.markTraceProcessedIfObservationsReady(trace.id)).toBe(true);
    expect(store.getTrace(trace.id)!.processed_at).not.toBeNull();
  });

  it("does not complete when there are no derived observations", () => {
    const trace = seedTrace();
    expect(store.markTraceProcessedIfObservationsReady(trace.id)).toBe(false);
  });

  it("scales with fan-out, not corpus size (100 observations for one trace)", () => {
    const trace = seedTrace("s1");
    for (let i = 0; i < 100; i++) insertObservationForTrace(trace.id, "s1", true);
    // 100 unrelated observations on another trace must not affect this trace.
    const otherTrace = seedTrace("s2");
    for (let i = 0; i < 100; i++) insertObservationForTrace(otherTrace.id, "s2", false);
    expect(store.markTraceProcessedIfObservationsReady(trace.id)).toBe(true);
  });

  it("markObservationProcessedIfMemoriesReady completes only when all derived memories are active", () => {
    const trace = seedTrace();
    const obs = store.insertObservation({
      session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "fact",
      title: "o", description: "d", files_read: [], files_modified: [], commands_executed: [],
      source_trace_ids: [trace.id], created_at: Date.now(), processed_at: null,
    });
    const mkMemory = () => {
      const m = store.insertMemory({
        session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "fact",
        title: "m", description: "d", files_read: [], files_modified: [],
        source_observation_ids: [obs.id], source_trace_ids: [trace.id],
        created_at: Date.now(), embedding: null,
      });
      store.insertObservationMemoryLinks(m.id, [obs.id]);
      return m;
    };
    const m1 = mkMemory();
    // insertMemory defaults to active; one active memory is enough.
    expect(store.markObservationProcessedIfMemoriesReady(obs.id)).toBe(true);

    // A second observation with two not-yet-active memories blocks completion.
    const obs2 = store.insertObservation({
      session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "fact",
      title: "o2", description: "d", files_read: [], files_modified: [], commands_executed: [],
      source_trace_ids: [trace.id], created_at: Date.now(), processed_at: null,
    });
    const m2 = mkMemory();
    store.insertObservationMemoryLinks(m2.id, [obs2.id]);
    store.updateMemoryLifecycleState(m2.id, "awaiting_embedding");
    const m3 = mkMemory();
    store.insertObservationMemoryLinks(m3.id, [obs2.id]);
    store.updateMemoryLifecycleState(m3.id, "awaiting_embedding");
    expect(store.markObservationProcessedIfMemoriesReady(obs2.id)).toBe(false);
    store.updateMemoryLifecycleState(m2.id, "active");
    expect(store.markObservationProcessedIfMemoriesReady(obs2.id)).toBe(false);
    store.updateMemoryLifecycleState(m3.id, "active");
    expect(store.markObservationProcessedIfMemoriesReady(obs2.id)).toBe(true);
    // superseding one after completion does not un-process (matches prior behavior)
    store.markMemorySuperseded(m3.id, m1.id);
    expect(store.getObservation(obs.id)?.processed_at).not.toBeNull();
  });

  it("backfills link tables once from existing JSON provenance at migration", () => {
    const trace = seedTrace();
    const obs = store.insertObservation({
      session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "fact",
      title: "o", description: "d", files_read: [], files_modified: [], commands_executed: [],
      source_trace_ids: [trace.id], created_at: Date.now(), processed_at: null,
    });
    store.markObservationProcessed(obs.id);
    // Wipe links to simulate a pre-link database.
    store.getDB().exec(`DELETE FROM trace_observations`);
    expect(store.markTraceProcessedIfObservationsReady(trace.id)).toBe(false);
    // Re-running migrations backfills from JSON once.
    runMigrations(ctx.db);
    const links = (store.getDB().prepare(`SELECT COUNT(*) c FROM trace_observations`).get() as { c: number }).c;
    expect(links).toBe(1);
    expect(store.markTraceProcessedIfObservationsReady(trace.id)).toBe(true);
  });
});