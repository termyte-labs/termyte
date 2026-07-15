import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCommand } from "../src/cli/start.js";
import { loadConfig } from "../src/cli/config.js";
import { Store } from "../src/storage/store.js";

describe("termyte start", () => {
  let homeDir: string;
  let oldHome: string | undefined;
  let oldDb: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "termyte-start-"));
    oldHome = process.env.HOME;
    oldDb = process.env.TERMYTE_DB;
    process.env.HOME = homeDir;
    process.env.TERMYTE_DB = join(homeDir, "termyte.db");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "settings.json"), JSON.stringify({ hooks: [{ command: "termyte-hook claude-code context" }] }), "utf-8");
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDb === undefined) delete process.env.TERMYTE_DB;
    else process.env.TERMYTE_DB = oldDb;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("prints health and writes a portable shared context file", async () => {
    const config = loadConfig();
    const store = new Store(config.dbPath);
    try {
      store.upsertSession("s1", "test", "github.com/test/repo", homeDir);
      store.insertMemory({
        type: "fact",
        title: "Start command memory",
        description: "This memory should be exported for another agent.",
        workspace_root: homeDir,
        repo_id: "github.com/test/repo",
        session_id: "s1",
        files_read: [],
        files_modified: [],
        source_trace_ids: [],
        source_observation_ids: [],
        created_at: Date.now(),
        lifecycle_state: "active",
      });

      const lines: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      try {
        await startCommand({ repo_id: "github.com/test/repo", path: join(homeDir, ".termyte", "share", "context.md") });
      } finally {
        writeSpy.mockRestore();
      }

      const out = lines.join("");
      expect(out).toContain("Termyte Start");
      expect(out).toContain("shared context:");
      const sharedPath = join(homeDir, ".termyte", "share", "context.md");
      expect(readFileSync(sharedPath, "utf-8")).toContain("Start command memory");
    } finally {
      store.close();
    }
  });

  it("emits machine-readable onboarding output", async () => {
    const config = loadConfig();
    const store = new Store(config.dbPath);
    try {
      store.upsertSession("s1", "test", "github.com/test/repo", homeDir);
      store.insertMemory({
        type: "fact",
        title: "JSON Start command memory",
        description: "This memory should be exported for another agent.",
        workspace_root: homeDir,
        repo_id: "github.com/test/repo",
        session_id: "s1",
        files_read: [],
        files_modified: [],
        source_trace_ids: [],
        source_observation_ids: [],
        created_at: Date.now(),
        lifecycle_state: "active",
      });

      const lines: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      try {
        await startCommand({ repo_id: "github.com/test/repo", path: join(homeDir, ".termyte", "share", "context.md"), json: true });
      } finally {
        writeSpy.mockRestore();
      }

      const parsed = JSON.parse(lines.join("")) as {
        sharedContextPath: string;
        repoId: string | null;
        workspaceRoot: string;
        queue: { pending: number };
      };
      expect(parsed.sharedContextPath).toContain(".termyte");
      expect(parsed.repoId).toBe("github.com/test/repo");
      expect(parsed.workspaceRoot.replaceAll("\\", "/")).toBe(process.cwd().replaceAll("\\", "/"));
      expect(typeof parsed.queue.pending).toBe("number");
    } finally {
      store.close();
    }
  });
});
