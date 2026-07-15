import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { smokeCommand } from "../src/cli/smoke.js";
import { Store } from "../src/storage/store.js";
import { loadConfig } from "../src/cli/config.js";

describe("termyte smoke", () => {
  let homeDir: string;
  let oldHome: string | undefined;
  let oldDb: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "termyte-smoke-"));
    oldHome = process.env.HOME;
    oldDb = process.env.TERMYTE_DB;
    originalCwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.TERMYTE_DB = join(homeDir, "termyte.db");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "settings.json"), JSON.stringify({ hooks: [{ command: "termyte-hook claude-code context" }] }), "utf-8");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDb === undefined) delete process.env.TERMYTE_DB;
    else process.env.TERMYTE_DB = oldDb;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("exports a smoke report and shared context", async () => {
    const config = loadConfig();
    const store = new Store(config.dbPath);
    try {
      store.upsertSession("s1", "test", "github.com/test/repo", originalCwd);
      store.insertMemory({
        type: "fact",
        title: "Smoke memory",
        description: "This should appear in the smoke shared context.",
        workspace_root: originalCwd,
        repo_id: "github.com/test/repo",
        session_id: "s1",
        files_read: [],
        files_modified: [],
        source_trace_ids: [],
        source_observation_ids: [],
        created_at: Date.now(),
        lifecycle_state: "active",
      });

      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      try {
        await smokeCommand({ repo_id: "github.com/test/repo", json: true });
      } finally {
        spy.mockRestore();
      }

      const parsed = JSON.parse(writes.join("")) as {
        repoId: string | null;
        sharedContextPath: string;
        sharedContextPresent: boolean;
        health: { queue: { pending: number } };
      };
      expect(parsed.repoId).toBe("github.com/test/repo");
      expect(parsed.sharedContextPresent).toBe(true);
      expect(parsed.sharedContextPath).toContain(".termyte");
      expect(typeof parsed.health.queue.pending).toBe("number");
      expect(readFileSync(parsed.sharedContextPath, "utf-8")).toContain("Smoke memory");
    } finally {
      store.close();
    }
  });

  it("can invoke an adapter in smoke mode and report the result", async () => {
    const config = loadConfig();
    const store = new Store(config.dbPath);
    try {
      store.upsertSession("s1", "test", "github.com/test/repo", originalCwd);
      store.insertMemory({
        type: "fact",
        title: "Invoke smoke memory",
        description: "This should appear before adapter invocation.",
        workspace_root: originalCwd,
        repo_id: "github.com/test/repo",
        session_id: "s1",
        files_read: [],
        files_modified: [],
        source_trace_ids: [],
        source_observation_ids: [],
        created_at: Date.now(),
        lifecycle_state: "active",
      });

      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      try {
        await smokeCommand({ repo_id: "github.com/test/repo", adapter: "fake", prompt: "smoke test prompt", json: true });
      } finally {
        spy.mockRestore();
      }

      const parsed = JSON.parse(writes.join("")) as {
        agentInvocation?: { adapter: string; prompt: string; text: string; durationMs: number };
      };
      expect(parsed.agentInvocation?.adapter).toBe("fake");
      expect(parsed.agentInvocation?.prompt).toBe("smoke test prompt");
      expect(parsed.agentInvocation?.text).toBe("<skip_summary />");
    } finally {
      store.close();
    }
  });
});
