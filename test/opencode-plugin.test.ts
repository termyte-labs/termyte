import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    on: vi.fn(),
  })),
  spawnSyncMock: vi.fn(() => ({
    status: 0,
    stdout: "## Memory #1\nContext from Termyte\n",
    stderr: "",
  })),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

describe("OpenCode plugin", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalCwd: string;
  let originalOcCfg: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "termyte-opencode-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalCwd = process.cwd();
    originalOcCfg = process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.OPENCODE_CONFIG_DIR = join(homeDir, ".config", "opencode");
    process.chdir(homeDir);
    spawnMock.mockClear();
    spawnSyncMock.mockReset();
  });

  function makeSpawnSyncWithPortableWrite() {
    spawnSyncMock.mockImplementation((_cmd, argv) => {
      const args = Array.isArray(argv) ? argv as string[] : [];
      const writeIndex = args.indexOf("--write-file");
      const sharedPath = writeIndex >= 0 ? args[writeIndex + 1] : undefined;
      if (sharedPath) {
        mkdirSync(join(sharedPath, ".."), { recursive: true });
        writeFileSync(sharedPath, "# Memory Context for repo\n\n## Memories (1)\n\n### [fact] Shared memory\nRead me in another agent.\n", "utf-8");
      }
      return {
        status: 0,
        stdout: sharedPath ? readFileSync(sharedPath, "utf-8") : "",
        stderr: "",
      };
    });
  }

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOcCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOcCfg;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("consumes the shared portable context file when present", async () => {
    const sharedPath = join(homeDir, ".termyte", "share", "context.md");
    mkdirSync(join(homeDir, ".termyte", "share"), { recursive: true });
    writeFileSync(sharedPath, "# Memory Context for repo\n\n## Memories (1)\n\n### [fact] Shared memory\nRead me in another agent.\n", "utf-8");
    spawnSyncMock.mockImplementation(() => ({
      status: 0,
      stdout: readFileSync(sharedPath, "utf-8"),
      stderr: "",
    }));

    const mod = await import("../src/integrations/opencode-plugin/index.js");
    const plugin = mod.default as {
      "experimental.hook": (eventName: string, payload: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<void>;
    };

    await plugin["experimental.hook"]("session.idle", {
      sessionID: "sess-2",
      event: "session.idle",
      directory: process.cwd(),
    }, {});

    const agentsPath = join(homeDir, ".config", "opencode", "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);
    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("Shared memory");
    expect(content).toContain("Read me in another agent.");
  });
});
