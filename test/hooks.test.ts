import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { Observer } from "../src/context/observations/pipeline.js";
import { HookRunner, shouldEnqueueObservation } from "../src/agents/hooks/runner.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { MockLLM } from "./mock-llm.js";
import { FakeLLMProvider } from "../src/context/observations/fake-provider.js";

let ctx: DatabaseContext;

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

describe("HookRunner", () => {
  it("processes a raw Claude Code event into an observation", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>bugfix</type>
      <title>Auth trailing space</title>
      <description>Trim tokens before validation.</description>
      <files_modified><file>src/auth.ts</file></files_modified>
    </observation>`);
    const observer = new Observer({ store, llm });
    const runner = new HookRunner({ store, observer });

    const ok = await runner.processRaw("claude-code", {
      session_id: "s1",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "src/auth.ts" },
      tool_response: "ok",
      hook_event_name: "PostToolUse",
    });
    expect(ok).toBe(true);
    expect(llm.calls).toHaveLength(0);
    expect(store.getRecentObservations(10)).toHaveLength(0);
    const queued = store.getDB().prepare(
      `SELECT state FROM jobs WHERE kind = 'synthesize_episode'`
    ).get() as { state: string };
    expect(queued.state).toBe("pending");
    await observer.flush();
    const obs = store.getRecentObservations(10);
    expect(obs.length).toBe(1);
    expect(obs[0]!.title).toBe("Auth trailing space");
    expect(obs[0]!.files_modified).toEqual(["src/auth.ts"]);
    store.close();
  });

  it("upserts a session from cwd before ingesting the trace", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<skip_summary />`);
    const observer = new Observer({ store, llm });
    const runner = new HookRunner({ store, observer });

    await runner.processRaw("claude-code", {
      session_id: "s-from-cwd",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "ok",
    });
    await observer.flush();
    const session = store.getSession("s-from-cwd");
    expect(session).not.toBeNull();
    expect(session!.project).toBe("work");
    store.close();
  });

  it("production session mode consolidates the complete session once at session end", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<observation><type>fact</type><title>Complete session</title><description>All session evidence.</description></observation>`);
    const observer = new Observer({ store, llm });
    const runner = new HookRunner({ store, observer, sessionConsolidation: true });

    await runner.processRaw("claude-code", { session_id: "session-mode", cwd: "/work", tool_name: "Read", tool_input: { file_path: "src/a.ts" } });
    await runner.processRaw("claude-code", { session_id: "session-mode", cwd: "/work", tool_name: "Bash", tool_input: { command: "npm test" }, tool_output: { status: "ok" } });
    await runner.processRaw("claude-code", { session_id: "session-mode", cwd: "/work", hook_event_name: "SessionEnd" });

    const job = store.getDB().prepare(`SELECT kind FROM jobs WHERE kind = 'consolidate_session' AND subject_id = 'session-mode'`).get() as { kind: string } | undefined;
    expect(job?.kind).toBe("consolidate_session");
    expect(store.getRecentObservations(10)).toHaveLength(0);
    await observer.flush();
    const observations = store.getObservationsForSession("session-mode");
    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0]!.source_trace_ids.length).toBe(2);
    store.close();
  });

  it("returns false on an empty / unparseable raw payload", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const runner = new HookRunner({ store, observer });
    expect(await runner.processRaw("claude-code", null)).toBe(false);
    expect(await runner.processRaw("claude-code", {})).toBe(false);
    store.close();
  });

  it("handles each of the adapters", async () => {
    const store = new Store(ctx);
    const llm = new FakeLLMProvider();
    const observer = new Observer({ store, llm });
    const runner = new HookRunner({ store, observer });

    const samples: Array<{ platform: "claude-code" | "codex" | "raw"; payload: any }> = [
      { platform: "claude-code", payload: { session_id: "a", tool_name: "Read", tool_input: null, tool_response: null } },
      { platform: "codex", payload: { session_id: "b", tool_name: "Read", tool_input: null, tool_response: null } },
      { platform: "raw", payload: { session_id: "c", tool_name: "Read", tool_input: null } },
    ];

    for (const s of samples) {
      const ok = await runner.processRaw(s.platform, s.payload);
      expect(ok).toBe(true);
    }
    await observer.flush();
    expect(store.getObservationsForSession("a").length).toBe(1);
    expect(store.getObservationsForSession("b").length).toBe(1);
    expect(store.getObservationsForSession("c").length).toBe(1);
    store.close();
  });

  it("does not enqueue observer synthesis for prompts or session lifecycle events", () => {
    const base = { session_id: "s", timestamp: 1, tool_input: null, tool_output: null, files_read: null, files_modified: null, final_response: null, cwd: "/work" };
    expect(shouldEnqueueObservation({ ...base, event_type: "user_prompt", tool_name: null, user_prompt: "fix it" })).toBe(false);
    expect(shouldEnqueueObservation({ ...base, event_type: "session_init", tool_name: null, user_prompt: null })).toBe(false);
    expect(shouldEnqueueObservation({ ...base, event_type: "tool_use", tool_name: "Bash", user_prompt: null })).toBe(true);
  });
});