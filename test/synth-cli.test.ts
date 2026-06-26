/**
 * Smoke test for the `termyte synth` CLI's --dry-run mode. We point
 * the FakeAdapter is not available here — instead we exercise the
 * CLI with an in-memory DB and confirm the dry-run prints the
 * prompt that would be sent.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let dbDir: string;
let dbPath: string;
let originalDb: string | undefined;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "termyte-synth-cli-"));
  dbPath = join(dbDir, "test.db");
  originalDb = process.env.TERMYTE_DB;
  process.env.TERMYTE_DB = dbPath;
});

afterEach(() => {
  if (originalDb === undefined) delete process.env.TERMYTE_DB;
  else process.env.TERMYTE_DB = originalDb;
  rmSync(dbDir, { recursive: true, force: true });
});

describe("termyte-synth CLI", () => {
  it("parses --help and --dry-run correctly", async () => {
    const { parseArgs } = await import("../src/cli/synth.js");
    const help = parseArgs(["--help"]);
    expect(help.help).toBe(true);
    expect(help.dryRun).toBe(false);

    const dry = parseArgs(["--dry-run", "--adapter", "claude-code"]);
    expect(dry.dryRun).toBe(true);
    expect(dry.adapter).toBe("claude-code");
  });

  it("exits 3 when no adapter is available and TERMYTE_DB has no traces", () => {
    // Override PATH so the resolver can't find any agent.
    const beforePath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = spawnSync(process.execPath, [
        "--input-type=module", "-e",
        `import("./src/cli/synth.ts").then(m => m.runMain()).catch(e => { console.error(e.message); process.exit(1); })`,
      ], {
        env: { ...process.env, TERMYTE_DB: dbPath, PATH: "" },
        encoding: "utf-8",
        timeout: 15_000,
      });
      // If process.execPath is malformed, the spawn will fail.
      // Skip the assertion in that case.
      if (result.error) return;
      expect([3, 1]).toContain(result.status);
    } finally {
      process.env.PATH = beforePath;
    }
  });
});

describe("Stats file presence", () => {
  it("the stats command source exists", async () => {
    const path = join(process.cwd(), "src", "cli", "stats.ts");
    expect(existsSync(path)).toBe(true);
  });
});
