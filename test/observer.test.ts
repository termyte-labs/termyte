import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { Observer } from "../src/observer/pipeline.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { MockLLM } from "./mock-llm.js";

let ctx: DatabaseContext;

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

describe("Observer", () => {
  it("converts a trace into an observation (stage 1) and marks trace processed", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>bugfix</type>
      <title>Auth fails</title>
      <description>Tokens had whitespace. Trim before use.</description>
      <files_modified><file>src/auth/token.ts</file></files_modified>
    </observation>`);
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo", "repo-1", "/workspace");
    const trace = store.insertTrace({
      session_id: "s1", timestamp: Date.now(), event_type: "tool_use",
      tool_name: "Read", tool_input: { file_path: "src/auth/token.ts" },
      tool_output: "tokens are 'abc '", files_read: ["src/auth/token.ts"],
      files_modified: null, user_prompt: null, final_response: null,
    });

    const observations = await observer.processTraceToObservation(trace);
    expect(observations.length).toBe(1);
    expect(observations[0]!.title).toBe("Auth fails");
    expect(observations[0]!.type).toBe("bugfix");
    expect(observations[0]!.source_trace_ids).toEqual([trace.id]);
    expect(observations[0]!.repo_id).toBe("repo-1");

    // Trace must be marked processed
    const unprocessed = store.getUnprocessedTraces();
    expect(unprocessed.length).toBe(0);
    store.close();
  });

  it("consolidates observations into memories (stage 2)", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "r1", "/w");
    const obs = store.insertObservation({
      session_id: "s1", repo_id: "r1", workspace_root: "/w",
      type: "bugfix", title: "Auth fix 1",
      description: "Trim tokens", files_read: [], files_modified: ["src/auth/token.ts"],
      commands_executed: [], source_trace_ids: [1], created_at: Date.now(), processed_at: null,
    });
    const obs2 = store.insertObservation({
      session_id: "s1", repo_id: "r1", workspace_root: "/w",
      type: "bugfix", title: "Auth fix 2",
      description: "Validate tokens", files_read: [], files_modified: ["src/auth/validate.ts"],
      commands_executed: [], source_trace_ids: [2], created_at: Date.now(), processed_at: null,
    });

    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>bugfix</type>
      <title>Fixed auth token handling</title>
      <description>Consolidated: tokens are now trimmed AND validated.</description>
      <files_modified><file>src/auth/token.ts</file></files_modified>
    </observation>`);
    const observer = new Observer({ store, llm });
    const memories = await observer.consolidateObservations([obs, obs2]);
    expect(memories.length).toBe(1);
    expect(memories[0]!.title).toBe("Fixed auth token handling");
    expect(memories[0]!.source_observation_ids).toEqual([obs.id, obs2.id]);
    expect(memories[0]!.source_trace_ids).toEqual([1, 2]);

    // Observations marked processed
    const gotObs = store.getObservation(obs.id);
    expect(gotObs!.processed_at).not.toBeNull();
    store.close();
  });

  it("generates a session summary", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "r1", "/w");
    const llm = new MockLLM();
    llm.setResponse(`<summary>
      <summary_text>Fixed login by trimming auth tokens.</summary_text>
      <key_changes><change>Trimming tokens</change></key_changes>
      <key_learnings><learning>Tokens have whitespace</learning></key_learnings>
    </summary>`);
    const observer = new Observer({ store, llm });
    const summary = await observer.generateSummary("s1", {
      user_prompts: ["Fix login bug"],
      final_response: "Done, tokens are now trimmed.",
      files_modified: ["src/auth/token.ts"],
    });
    expect(summary).not.toBeNull();
    expect(summary!.summary).toBe("Fixed login by trimming auth tokens.");
    expect(summary!.key_changes).toEqual(["Trimming tokens"]);
    expect(summary!.key_learnings).toEqual(["Tokens have whitespace"]);
    store.close();
  });

  it("marks trace processed on skip response", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<skip_summary />`);
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo", "r1", "/w");
    const trace = store.insertTrace({
      session_id: "s1", timestamp: 1, event_type: "tool_use",
      tool_name: "Read", tool_input: null, tool_output: null,
      files_read: null, files_modified: null, user_prompt: null, final_response: null,
    });
    const observations = await observer.processTraceToObservation(trace);
    expect(observations.length).toBe(0);
    expect(store.getUnprocessedTraces().length).toBe(0);
    store.close();
  });

  it("marks trace processed on invalid XML", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse("just some prose");
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo", "r1", "/w");
    const trace = store.insertTrace({
      session_id: "s1", timestamp: 1, event_type: "tool_use",
      tool_name: "Read", tool_input: null, tool_output: null,
      files_read: null, files_modified: null, user_prompt: null, final_response: null,
    });
    const observations = await observer.processTraceToObservation(trace);
    expect(observations.length).toBe(0);
    expect(store.getUnprocessedTraces().length).toBe(0);
    store.close();
  });

  it("enqueue + flush runs observer asynchronously", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>fact</type>
      <title>queued works</title>
    </observation>`);
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo", "r1", "/w");
    const trace = store.insertTrace({
      session_id: "s1", timestamp: 1, event_type: "tool_use",
      tool_name: "Read", tool_input: null, tool_output: null,
      files_read: null, files_modified: null, user_prompt: null, final_response: null,
    });
    observer.enqueue(trace);
    await observer.flush();
    const observations = store.getRecentObservations(10);
    expect(observations.length).toBe(1);
    store.close();
  });

  it("processUnprocessedOnce processes traces through both stages", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "r1", "/w");
    store.insertTrace({
      session_id: "s1", timestamp: 1, event_type: "tool_use",
      tool_name: "Read", tool_input: null, tool_output: null,
      files_read: null, files_modified: null, user_prompt: null, final_response: null,
    });
    expect(store.getUnprocessedTraces().length).toBe(1);

    const llm = new MockLLM();
    // First call: observation extraction
    llm.setResponses([
      `<observation><type>fact</type><title>caught up</title></observation>`,
      `<observation><type>fact</type><title>consolidated</title></observation>`,
    ]);
    const observer = new Observer({ store, llm });
    const n = await observer.processUnprocessedOnce();
    expect(n).toBe(1);
    expect(store.getUnprocessedTraces().length).toBe(0);

    const observations = store.getRecentObservations(10);
    expect(observations.length).toBe(1);
    const memories = store.getRecentMemories(10);
    expect(memories.length).toBe(1);
    store.close();
  });
});
