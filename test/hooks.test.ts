import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { Observer } from "../src/observer/pipeline.js";
import { HookRunner } from "../src/hooks/runner.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { MockLLM } from "./mock-llm.js";

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

  it("returns false on an empty / unparseable raw payload", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const runner = new HookRunner({ store, observer });
    expect(await runner.processRaw("claude-code", null)).toBe(false);
    expect(await runner.processRaw("claude-code", {})).toBe(false);
    store.close();
  });

  it("handles each of the four adapters", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    llm.setResponse(`<observation>
      <type>bugfix</type>
      <title>Adapter test</title>
    </observation>`);
    const observer = new Observer({ store, llm });
    const runner = new HookRunner({ store, observer });

    const samples: Array<{ platform: "claude-code" | "codex" | "opencode" | "cursor"; payload: any }> = [
      { platform: "claude-code", payload: { session_id: "a", tool_name: "Read", tool_input: null, tool_response: null } },
      { platform: "codex", payload: { session_id: "b", tool_name: "Read", tool_input: null, tool_response: null } },
      { platform: "opencode", payload: { sessionID: "c", tool: "Read", args: null, output: null } },
      { platform: "cursor", payload: { conversation_id: "d", tool_name: "Read", tool_input: null, result_json: null } },
    ];

    for (const s of samples) {
      const ok = await runner.processRaw(s.platform, s.payload);
      expect(ok).toBe(true);
    }
    await observer.flush();
    expect(store.getObservationsForSession("a").length).toBe(1);
    expect(store.getObservationsForSession("b").length).toBe(1);
    expect(store.getObservationsForSession("c").length).toBe(1);
    expect(store.getObservationsForSession("d").length).toBe(1);
    store.close();
  });
});
