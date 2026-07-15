import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase } from "../src/storage/connection.js";
import { runMigrations } from "../src/storage/migrations.js";

describe("memory feedback migration", () => {
  it("preserves legacy created_at when correction_text was appended later", () => {
    const store = new Store(openDatabase(":memory:"));
    try {
      store.upsertSession("s1", "test", "repo", "/repo");
      const memory = store.insertMemory({
        session_id: "s1", repo_id: "repo", workspace_root: "/repo", type: "fact",
        title: "Legacy", description: null, files_read: [], files_modified: [],
        source_observation_ids: [], source_trace_ids: [], created_at: 1, embedding: null,
      });
      const db = store.getDB();
      db.exec(`
        DROP INDEX idx_memory_feedback_memory;
        DROP INDEX idx_memory_feedback_context;
        DROP TABLE memory_feedback;
        CREATE TABLE memory_feedback (
          id TEXT PRIMARY KEY,
          memory_id INTEGER NOT NULL REFERENCES memories(id),
          doc_id TEXT,
          event_type TEXT NOT NULL CHECK(event_type IN ('shown', 'used', 'ignored', 'downranked', 'corrected')),
          weight REAL NOT NULL,
          source TEXT NOT NULL,
          context_injection_id TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare(`
        INSERT INTO memory_feedback
          (id, memory_id, doc_id, event_type, weight, source, context_injection_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("legacy-feedback", memory.id, `memory:${memory.id}`, "shown", 0, "legacy", null, 1234);

      runMigrations(db);

      const row = db.prepare("SELECT created_at, correction_text, event_type FROM memory_feedback WHERE id = ?")
        .get("legacy-feedback") as { created_at: number; correction_text: string | null; event_type: string };
      expect(row).toEqual({ created_at: 1234, correction_text: null, event_type: "shown" });
    } finally {
      store.close();
    }
  });
});
