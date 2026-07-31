import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";

describe("evidence-level memory provenance", () => {
  it("links memory evidence and cascades episode deletion without stale claims", () => {
    const store = new Store(openDatabase(":memory:"));
    store.upsertSession("s1", "repo", "r1", "/w");
    const episode = store.startEpisode({ sessionId: "s1", repoId: "r1", workspaceRoot: "/w", task: "Prove it" });
    const trace = store.insertTrace({
      session_id: "s1", timestamp: 1, event_type: "tool_use", tool_name: "Bash",
      tool_input: { command: "npm test" }, tool_output: { exit_code: 0 },
      files_read: null, files_modified: null, user_prompt: null, final_response: null,
    });
    store.linkTraceToEpisode(episode.id, trace.id);
    const evidence = store.insertEvidence({
      episodeId: episode.id, kind: "test", content: "npm test", exitCode: 0, traceIds: [trace.id],
    });
    const memory = store.insertMemory({
      session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "procedure",
      title: "Run tests", description: null, files_read: [], files_modified: [],
      source_observation_ids: [], source_trace_ids: [trace.id], created_at: 2, embedding: null,
    });
    store.linkMemoryEvidence(memory.id, [evidence.id, evidence.id]);

    expect(store.getMemoryEvidenceLinks(memory.id).map((link) => link.evidence_id)).toEqual([evidence.id]);
    expect(store.getActiveMemoryProvenanceViolations()).not.toContain(memory.id);

    store.getDB().prepare(`DELETE FROM episodes WHERE id = ?`).run(episode.id);

    expect(store.getMemoryEvidenceLinks(memory.id)).toEqual([]);
    expect(store.getActiveMemoryProvenanceViolations()).not.toContain(memory.id);
    store.getDB().prepare(`DELETE FROM traces WHERE id = ?`).run(trace.id);
    expect(store.getActiveMemoryProvenanceViolations()).toContain(memory.id);
    expect((store.getDB().prepare(`PRAGMA foreign_key_check`).all())).toEqual([]);
    store.close();
  });
});