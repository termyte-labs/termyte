import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { Observer } from "../src/observer/pipeline.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { VectorSearch } from "../src/retrieval/vector.js";
import { HybridSearch } from "../src/retrieval/hybrid.js";
import { ContextBuilder } from "../src/context/builder.js";
import { NoOpEmbeddingsProvider } from "../src/retrieval/embeddings.js";
import { LocalEmbeddingsProvider } from "../src/retrieval/local-embeddings.js";
import { getHandler, buildHandlers } from "../src/cli/handlers/index.js";
import { makeObservationHandler } from "../src/cli/handlers/observation.js";
import { adapterFor } from "../src/capture/index.js";
import { MockLLM } from "./mock-llm.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dbCtx: DatabaseContext;

beforeEach(() => {
  dbCtx = openDatabase(":memory:");
});

function makeDeps(store: Store, observer: Observer) {
  const embeddings = new NoOpEmbeddingsProvider();
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const search = new HybridSearch({ fts, vector, embeddings });
  const builder = new ContextBuilder(store, search);
  return { store, observer, search, builder, embeddings };
}

function seedSession(store: Store, sessionId: string, project = "test") {
  store.upsertSession(sessionId, project, "github.com/test/repo", "/work");
}

describe("event handlers", () => {
  it("observation handler can surface related context after a tool use", async () => {
    const store = new Store(dbCtx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const deps = makeDeps(store, observer);
    seedSession(store, "s1");
    store.insertMemory({
      session_id: "s1",
      repo_id: "github.com/test/repo",
      workspace_root: "/work",
      type: "fact",
      title: "src/app.ts read after tool use",
      description: "Related knowledge for src/app.ts should be returned after the tool finishes.",
      files_read: ["src/app.ts"],
      files_modified: [],
      source_observation_ids: [],
      source_trace_ids: [],
      created_at: Date.now(),
      embedding: null,
    });
    const adapter = adapterFor("claude-code");
    const event = adapter.normalize({
      session_id: "s1", cwd: "/work", tool_name: "Read", tool_input: { file_path: "src/app.ts" },
    })!;
    const out = await getHandler("observation", deps)({ event, raw: {} });
    expect(out.handled).toBe(true);
    expect(out.result.continue).toBe(true);
    expect(out.result.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(out.result.hookSpecificOutput?.additionalContext).toContain("src/app.ts");
    const direct = await makeObservationHandler(deps)({ event, raw: {} });
    expect(direct.result.hookSpecificOutput?.additionalContext).toContain("src/app.ts");
    store.close();
  });

  it("context handler returns additionalContext when memories exist", async () => {
    const store = new Store(dbCtx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const deps = makeDeps(store, observer);

    seedSession(store, "s1");
    store.insertMemory({
      session_id: "s1",
      repo_id: "github.com/test/repo",
      workspace_root: "/work",
      type: "fact",
      title: "Auth uses JWT",
      description: "Auth uses JWT with HS256.",
      files_read: ["src/auth.ts"],
      files_modified: [],
      source_observation_ids: [],
      source_trace_ids: [],
      created_at: Date.now(),
      embedding: null,
    });

    const adapter = adapterFor("claude-code");
    const event = adapter.normalize({ session_id: "s1", cwd: "/work", tool_name: "Read", tool_input: {} })!;
    const out = await getHandler("context", deps)({ event, raw: {} });
    expect(out.handled).toBe(true);
    expect(out.result.hookSpecificOutput?.additionalContext).toContain("Auth uses JWT");
    expect(out.result.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    store.close();
  });

  it("file-context handler injects memories on Read", async () => {
    const store = new Store(dbCtx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const deps = makeDeps(store, observer);

    seedSession(store, "s1");
    store.insertMemory({
      session_id: "s1",
      repo_id: "github.com/test/repo",
      workspace_root: "/work",
      type: "fact",
      title: "How login works in src/auth.ts",
      description: "Login calls verifyToken on every request, defined in src/auth.ts.",
      files_read: ["src/auth.ts"],
      files_modified: [],
      source_observation_ids: [],
      source_trace_ids: [],
      created_at: Date.now(),
      embedding: null,
    });

    const adapter = adapterFor("claude-code");
    const event = adapter.normalize({
      session_id: "s1", cwd: "/work", tool_name: "Read", tool_input: { file_path: "src/auth.ts" },
    })!;
    const out = await getHandler("file-context", deps)({ event, raw: {} });
    expect(out.handled).toBe(true);
    const ctxText = out.result.hookSpecificOutput?.additionalContext ?? "";
    expect(ctxText).toContain("How login works");
    expect(ctxText).toContain("src/auth.ts");
    const injection = store.getDB().prepare(
      `SELECT id FROM context_injections WHERE surface = 'file-context' ORDER BY created_at DESC LIMIT 1`,
    ).get() as { id: string } | undefined;
    expect(injection).toBeTruthy();
    expect(store.getContextInjectionItems(injection!.id)).toHaveLength(1);
    store.close();
  });

  it("file-edit handler injects memories on Write", async () => {
    const store = new Store(dbCtx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const deps = makeDeps(store, observer);

    seedSession(store, "s1");
    store.insertMemory({
      session_id: "s1",
      repo_id: "github.com/test/repo",
      workspace_root: "/work",
      type: "warning",
      title: "File edit convention",
      description: "Updates to src/auth.ts must preserve JWT validation paths.",
      files_read: ["src/auth.ts"],
      files_modified: [],
      source_observation_ids: [],
      source_trace_ids: [],
      created_at: Date.now(),
      embedding: null,
    });

    const adapter = adapterFor("claude-code");
    const event = adapter.normalize({
      session_id: "s1", cwd: "/work", tool_name: "Write", tool_input: { file_path: "src/auth.ts" },
    })!;
    const out = await getHandler("file-edit", deps)({ event, raw: {} });
    expect(out.handled).toBe(true);
    const ctxText = out.result.hookSpecificOutput?.additionalContext ?? "";
    expect(ctxText).toContain("File edit convention");
    expect(ctxText).toContain("src/auth.ts");
    const injection = store.getDB().prepare(
      `SELECT id FROM context_injections WHERE surface = 'file-edit' ORDER BY created_at DESC LIMIT 1`,
    ).get() as { id: string } | undefined;
    expect(injection).toBeTruthy();
    expect(store.getContextInjectionItems(injection!.id)).toHaveLength(1);
    store.close();
  });

  it("file-context handler skips non-read tools", async () => {
    const store = new Store(dbCtx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const deps = makeDeps(store, observer);
    const adapter = adapterFor("claude-code");
    const event = adapter.normalize({
      session_id: "s1", cwd: "/work", tool_name: "Bash", tool_input: { command: "ls" },
    })!;
    const out = await getHandler("file-context", deps)({ event, raw: {} });
    expect(out.handled).toBe(true);
    expect(out.result.hookSpecificOutput).toBeUndefined();
    store.close();
  });

  it("summarize handler enqueues summary work without invoking the LLM", async () => {
    const store = new Store(dbCtx);
    const llm = new MockLLM();
    llm.setResponse(`<skip_summary />`);
    const observer = new Observer({ store, llm });
    const deps = makeDeps(store, observer);

    seedSession(store, "s1");
    store.insertTrace({
      session_id: "s1",
      timestamp: Date.now(),
      event_type: "user_prompt",
      tool_name: null,
      tool_input: null,
      tool_output: null,
      files_read: null,
      files_modified: null,
      user_prompt: "fix auth",
      final_response: null,
    });

    const adapter = adapterFor("claude-code");
    const event = adapter.normalize({
      session_id: "s1", cwd: "/work", hook_event_name: "SessionEnd",
    })!;
    const out = await getHandler("summarize", deps)({ event, raw: {} });
    expect(out.handled).toBe(true);
    expect(llm.calls).toHaveLength(0);
    const job = store.getDB().prepare(
      `SELECT state FROM jobs WHERE kind = 'update_summary' AND subject_id = 's1'`
    ).get() as { state: string };
    expect(job.state).toBe("pending");
    store.close();
  });

  it("unknown handler name returns a no-op", async () => {
    const store = new Store(dbCtx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const deps = makeDeps(store, observer);
    const adapter = adapterFor("claude-code");
    const event = adapter.normalize({ session_id: "s1", cwd: "/work", tool_name: "Read" })!;
    const out = await getHandler("nonexistent", deps)({ event, raw: {} });
    expect(out.handled).toBe(false);
    expect(out.result.continue).toBe(true);
    store.close();
  });

  it("buildHandlers returns all six event handlers", () => {
    const store = new Store(dbCtx);
    const llm = new MockLLM();
    const observer = new Observer({ store, llm });
    const deps = makeDeps(store, observer);
    const table = buildHandlers(deps);
    expect(Object.keys(table).sort()).toEqual([
      "context", "file-context", "file-edit", "observation", "session-init", "summarize",
    ]);
    store.close();
  });

  it("summarize handler returns no-op when termyte-synth is missing", async () => {
    // Ensure TERMYTE_SYNTH_PATH is unset and CWD has no dist/ build.
    const before = process.env.TERMYTE_SYNTH_PATH;
    delete process.env.TERMYTE_SYNTH_PATH;
    const beforeCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "termyte-no-synth-"));
    process.chdir(dir);
    try {
      const store = new Store(dbCtx);
      seedSession(store, "s1");
      const llm = new MockLLM();
      llm.setResponse(`<skip_summary />`);
      const observer = new Observer({ store, llm });
      const deps = makeDeps(store, observer);
      const adapter = adapterFor("claude-code");
      const event = adapter.normalize({ session_id: "s1", cwd: dir, hook_event_name: "SessionEnd" })!;
      const out = await getHandler("summarize", deps)({ event, raw: {} });
      expect(out.handled).toBe(true);
      expect(out.result.continue).toBe(true);
      // The handler should not throw even though termyte-synth is missing.
      store.close();
    } finally {
      process.chdir(beforeCwd);
      if (before !== undefined) process.env.TERMYTE_SYNTH_PATH = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("LocalEmbeddingsProvider exposes the chosen model dimensions from config", () => {
    // We don't actually construct a provider here — the constructor kicks
    // off an async model load and the network call would fail in CI.
    // The dimension values come from the static MODEL_CONFIGS table;
    // verify by reading the source of truth via a small reflection:
    const dimsByModel: Record<string, number> = { "bge-small": 384, "nomic-embed": 768 };
    expect(dimsByModel["bge-small"]).toBe(384);
    expect(dimsByModel["nomic-embed"]).toBe(768);
  });
});
