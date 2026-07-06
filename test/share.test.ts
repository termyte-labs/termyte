import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { shareCommand } from "../src/cli/share.js";

let tempDir: string | null = null;
let oldDb = process.env.TERMYTE_DB;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "termyte-share-"));
  process.env.TERMYTE_DB = join(tempDir, "termyte.db");
});

afterEach(() => {
  process.env.TERMYTE_DB = oldDb;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("termyte share", () => {
  it("writes a portable markdown context file for another agent to read", async () => {
    const store = new Store(process.env.TERMYTE_DB!);
    try {
      store.upsertSession("s1", "repo", "github.com/test/repo", "/w");
      store.insertMemory({
        session_id: "s1",
        repo_id: "github.com/test/repo",
        workspace_root: "/w",
        type: "fact",
        title: "Shared memory",
        description: "This file can be handed to another agent.",
        files_read: ["src/shared.ts"],
        files_modified: [],
        source_observation_ids: [],
        source_trace_ids: [],
        created_at: Date.now(),
        embedding: null,
      });

      const outPath = join(tempDir!, ".termyte", "share", "context.md");
      await shareCommand({ repo_id: "github.com/test/repo", path: outPath });
      const content = readFileSync(outPath, "utf-8");
      expect(content).toContain("Shared memory");
      expect(content).toContain("This file can be handed to another agent.");
      expect(content).toContain("# Memory Context for github.com/test/repo");
    } finally {
      store.close();
    }
  });
});
