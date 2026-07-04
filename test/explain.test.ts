import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { buildMemoryExplain, renderMemoryExplain } from "../src/explain/memory-explain.js";
import { explainCommand } from "../src/cli/explain.js";

let ctx: DatabaseContext;
let tempDir: string | null = null;

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("memory explainability", () => {
  it("renders a memory lineage with traces, observations, edges, and feedback", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "repo", "/work");

    const trace = store.insertTrace({
      session_id: "s1",
      timestamp: 10,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: "src/auth.ts" },
      tool_output: { ok: true },
      files_read: ["src/auth.ts"],
      files_modified: [],
      user_prompt: "inspect auth",
      final_response: null,
    });

    const observation = store.insertObservation({
      session_id: "s1",
      repo_id: "repo",
      workspace_root: "/work",
      type: "fact",
      title: "Auth uses JWT",
      description: "Tokens are validated with HS256.",
      files_read: ["src/auth.ts"],
      files_modified: [],
      commands_executed: [],
      source_trace_ids: [trace.id],
      created_at: 20,
      lifecycle_state: "indexed",
    });
    store.insertTraceObservationLinks(observation.id, [trace.id]);

    const memory = store.insertMemory({
      session_id: "s1",
      repo_id: "repo",
      workspace_root: "/work",
      type: "fact",
      title: "Auth uses JWT",
      description: "Tokens are validated with HS256.",
      files_read: ["src/auth.ts"],
      files_modified: [],
      source_observation_ids: [observation.id],
      source_trace_ids: [trace.id],
      created_at: 30,
      embedding: null,
    });
    store.insertObservationMemoryLinks(memory.id, [observation.id]);

    const peer = store.insertMemory({
      session_id: "s1",
      repo_id: "repo",
      workspace_root: "/work",
      type: "fact",
      title: "Old auth note",
      description: "Deprecated note.",
      files_read: ["src/auth.ts"],
      files_modified: [],
      source_observation_ids: [],
      source_trace_ids: [],
      created_at: 5,
      embedding: null,
    });
    store.insertMemoryEdge({ source: memory.id, target: peer.id, edgeType: "supersedes" });
    store.recordMemoryFeedback({ id: `memory:${memory.id}`, event: "used", contextInjectionId: "ctx-1", source: "mcp" });

    const explanation = buildMemoryExplain(store, `memory:${memory.id}`);
    expect(explanation.found).toBe(true);
    expect(explanation.memory?.id).toBe(memory.id);
    expect(explanation.source_observations).toHaveLength(1);
    expect(explanation.source_traces).toHaveLength(1);
    expect(explanation.edges).toHaveLength(1);
    expect(explanation.feedback).toHaveLength(1);
    expect(renderMemoryExplain(explanation)).toContain("Auth uses JWT");
    expect(renderMemoryExplain(explanation)).toContain("trace:");
    expect(renderMemoryExplain(explanation)).toContain("observation:");
    expect(renderMemoryExplain(explanation)).toContain("supersedes");

    store.close();
  });

  it("preserves missing source references when the original rows are gone", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "repo", "/work");

    const trace = store.insertTrace({
      session_id: "s1",
      timestamp: 10,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: null,
      tool_output: null,
      files_read: null,
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });

    const observation = store.insertObservation({
      session_id: "s1",
      repo_id: "repo",
      workspace_root: "/work",
      type: "fact",
      title: "Delete me",
      description: null,
      files_read: [],
      files_modified: [],
      commands_executed: [],
      source_trace_ids: [trace.id],
      created_at: 20,
      lifecycle_state: "indexed",
    });

    const memory = store.insertMemory({
      session_id: "s1",
      repo_id: "repo",
      workspace_root: "/work",
      type: "fact",
      title: "Missing provenance",
      description: null,
      files_read: [],
      files_modified: [],
      source_observation_ids: [observation.id],
      source_trace_ids: [trace.id],
      created_at: 30,
      embedding: null,
    });

    store.getDB().prepare(`DELETE FROM observations WHERE id = ?`).run(observation.id);
    store.getDB().prepare(`DELETE FROM traces WHERE id = ?`).run(trace.id);

    const explanation = buildMemoryExplain(store, String(memory.id));
    expect(explanation.missing_source_observation_ids).toEqual([observation.id]);
    expect(explanation.missing_source_trace_ids).toEqual([trace.id]);
    const rendered = renderMemoryExplain(explanation);
    expect(rendered).toContain("Missing observations (missing):");
    expect(rendered).toContain("Missing traces (missing):");

    store.close();
  });

  it("supports the CLI explain command", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "termyte-explain-"));
    const dbPath = join(tempDir, "termyte.db");
    const store = new Store(dbPath);
    store.upsertSession("s1", "demo", "repo", "/work");
    const memory = store.insertMemory({
      session_id: "s1",
      repo_id: "repo",
      workspace_root: "/work",
      type: "fact",
      title: "CLI explain",
      description: "Available via the CLI.",
      files_read: [],
      files_modified: [],
      source_observation_ids: [],
      source_trace_ids: [],
      created_at: 1,
      embedding: null,
    });

    const oldDb = process.env.TERMYTE_DB;
    process.env.TERMYTE_DB = dbPath;
    try {
      const output = await captureStdout(() => explainCommand({ id: `memory:${memory.id}`, json: true }));
      const parsed = JSON.parse(output) as { found: boolean; memory: { title: string } | null };
      expect(parsed.found).toBe(true);
      expect(parsed.memory?.title).toBe("CLI explain");
    } finally {
      process.env.TERMYTE_DB = oldDb;
      store.close();
    }
  });
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
