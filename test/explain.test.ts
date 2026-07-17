import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { buildMemoryExplain, renderMemoryExplain } from "../src/explain/memory-explain.js";

let ctx: DatabaseContext;

beforeEach(() => {
  ctx = openDatabase(":memory:");
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
    store.recordContextInjection({ id: "ctx-1", sessionId: "s1", repoId: "repo", memoryIds: [memory.id], surface: "mcp" });
    store.recordMemoryFeedback({ id: `memory:${memory.id}`, event: "used", contextInjectionId: "ctx-1", source: "mcp" });
    store.upsertContextEffect({
      injectionId: "ctx-1", memoryId: memory.id, candidateId: `memory:${memory.id}`,
      verdict: "helped", confidence: 0.9,
    });

    const explanation = buildMemoryExplain(store, `memory:${memory.id}`);
    expect(explanation.found).toBe(true);
    expect(explanation.memory?.id).toBe(memory.id);
    expect(explanation.source_observations).toHaveLength(1);
    expect(explanation.source_traces).toHaveLength(1);
    expect(explanation.edges).toHaveLength(1);
    expect(explanation.feedback).toHaveLength(1);
    expect(explanation.context_effects).toEqual([expect.objectContaining({ verdict: "helped", confidence: 0.9 })]);
    expect(renderMemoryExplain(explanation)).toContain("Auth uses JWT");
    expect(renderMemoryExplain(explanation)).toContain("trace:");
    expect(renderMemoryExplain(explanation)).toContain("observation:");
    expect(renderMemoryExplain(explanation)).toContain("supersedes");
    expect(renderMemoryExplain(explanation)).toContain("## Context Effects");

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

  it("renders supporting evidence and diagnoses a broken evidence link", () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "repo", "/work");
    const episode = store.startEpisode({ sessionId: "s1", repoId: "repo", workspaceRoot: "/work", task: "Evidence" });
    const evidence = store.insertEvidence({ episodeId: episode.id, kind: "build", content: "npm run build", exitCode: 0 });
    const memory = store.insertMemory({
      session_id: "s1", repo_id: "repo", workspace_root: "/work", type: "fact",
      title: "Build passes", description: null, files_read: [], files_modified: [],
      source_observation_ids: [], source_trace_ids: [], created_at: 1, embedding: null,
    });
    store.linkMemoryEvidence(memory.id, [evidence.id]);

    let explanation = buildMemoryExplain(store, String(memory.id));
    expect(explanation.source_evidence).toEqual([expect.objectContaining({ id: evidence.id, kind: "build" })]);
    expect(explanation.provenance_valid).toBe(true);
    expect(renderMemoryExplain(explanation)).toContain(`${evidence.id} [build] npm run build`);

    store.getDB().exec(`PRAGMA foreign_keys = OFF`);
    store.getDB().prepare(`INSERT INTO memory_evidence (memory_id, evidence_id) VALUES (?, ?)`).run(memory.id, "evidence_missing");
    store.getDB().exec(`PRAGMA foreign_keys = ON`);
    explanation = buildMemoryExplain(store, String(memory.id));
    expect(explanation.missing_evidence_ids).toEqual(["evidence_missing"]);
    expect(explanation.provenance_valid).toBe(false);
    expect(renderMemoryExplain(explanation)).toContain("Missing evidence (broken link): evidence_missing");
    store.close();
  });

});
