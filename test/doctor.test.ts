import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("doctor command", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalDb: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "termyte-doctor-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalDb = process.env.TERMYTE_DB;
    originalCwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TERMYTE_DB = join(homeDir, "termyte.db");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalDb === undefined) delete process.env.TERMYTE_DB;
    else process.env.TERMYTE_DB = originalDb;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("reports install status and local health", async () => {
    const claudePath = join(homeDir, ".claude");
    mkdirSync(claudePath, { recursive: true });
    writeFileSync(join(claudePath, "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "node termyte-hook claude-code session-init" }] }],
      },
    }, null, 2));

    const mod = await import("../src/cli/doctor.js");
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let output = "";
    try {
      await mod.runMain();
      output = spy.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      spy.mockRestore();
    }
    expect(output).toContain("Termyte Doctor");
    expect(output).toContain("Claude Code: installed");
    expect(output).toContain("Codex: missing");
    expect(output).toContain("synthesis:");
    expect(output).toContain("Next steps:");
  });

  it("emits machine-readable runtime diagnostics", async () => {
    const mod = await import("../src/cli/doctor.js");
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let output = "";
    try {
      await mod.runDoctorJson();
      output = spy.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(output) as {
      dbPath: string;
      synthesis: string;
      queue: { pending: number; leased: number; dead: number };
      integrations: Array<{ name: string; installed: boolean }>;
    };
    expect(parsed.dbPath).toContain("termyte.db");
    expect(parsed.synthesis).toBe("capture-only");
    expect(typeof parsed.queue.pending).toBe("number");
    expect(parsed.integrations.length).toBeGreaterThan(0);
  });
});
