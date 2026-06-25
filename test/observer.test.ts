import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { Observer } from "../src/observer/pipeline.js";
import { openDatabase, closeDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { MockLLM } from "./mock-llm.js";

let ctx: DatabaseContext;

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

describe("Observer", () => {
  it("converts a trace into a memory and marks the trace processed", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>bugfix</type>
      <title>Auth fails</title>
      <facts><fact>Tokens have whitespace</fact></facts>
      <narrative>Trim before use.</narrative>
      <files_modified><file>src/auth/token.ts</file></files_modified>
    </observation>`);
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo");
    const trace = store.insertTrace({
      session_id: "s1",
      timestamp: Date.now(),
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: "src/auth/token.ts" },
      tool_output: "tokens are 'abc '",
      files_read: ["src/auth/token.ts"],
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });

    await observer.processOne(trace);
    await observer.flush();

    const memories = store.getMemoriesForSession("s1");
    expect(memories.length).toBe(1);
    expect(memories[0]!.title).toBe("Auth fails");
    expect(memories[0]!.type).toBe("bugfix");
    expect(memories[0]!.files_modified).toEqual(["src/auth/token.ts"]);

    const traces = store.getUnprocessedTraces();
    expect(traces.length).toBe(0);
    store.close();
  });

  it("persists a summary when the LLM returns one", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<summary>
      <request>Fix login</request>
      <learned>Tokens have whitespace</learned>
      <completed>Trim before use</completed>
    </summary>`);
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo");
    const trace = store.insertTrace({
      session_id: "s1",
      timestamp: Date.now(),
      event_type: "assistant_message",
      tool_name: null,
      tool_input: null,
      tool_output: null,
      files_read: null,
      files_modified: null,
      user_prompt: null,
      final_response: "all done",
    });
    await observer.processOne(trace);
    await observer.flush();
    const summary = store.getSummary("s1");
    expect(summary).not.toBeNull();
    expect(summary!.request).toBe("Fix login");
    expect(summary!.learned).toBe("Tokens have whitespace");
    store.close();
  });

  it("marks the trace processed on a skip_summary response", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<skip_summary reason="trivial" />`);
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo");
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
    await observer.processOne(trace);
    await observer.flush();
    expect(store.getUnprocessedTraces().length).toBe(0);
    expect(store.getMemoriesForSession("s1").length).toBe(0);
    store.close();
  });

  it("marks the trace processed on invalid XML (drops the batch)", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse("just some prose, no XML here");
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo");
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
    await observer.processOne(trace);
    await observer.flush();
    expect(store.getUnprocessedTraces().length).toBe(0);
    expect(store.getMemoriesForSession("s1").length).toBe(0);
    store.close();
  });

  it("enqueue + flush runs the observer asynchronously", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>discovery</type>
      <title>queued works</title>
    </observation>`);
    const observer = new Observer({ store, llm });
    store.upsertSession("s1", "demo");
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
    observer.enqueue(trace);
    await observer.flush();
    expect(store.getMemoriesForSession("s1").length).toBe(1);
    store.close();
  });

  it("processUnprocessedOnce picks up old traces on startup", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo");
    // Insert a trace with no observer in scope (simulates a previous run
    // that crashed before processing).
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

    // Now create a fresh observer and process.
    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>discovery</type>
      <title>caught up</title>
    </observation>`);
    const observer = new Observer({ store, llm });
    const n = await observer.processUnprocessedOnce();
    expect(n).toBe(1);
    expect(store.getUnprocessedTraces().length).toBe(0);
    expect(store.getMemoriesForSession("s1").length).toBe(1);
    store.close();
  });
});
