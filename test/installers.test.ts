import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFor, listSupportedPlatforms } from "../src/integrations/installers/index.js";

let homeDir: string;
let originalCwd: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "termyte-install-"));
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  const projectRoot = process.cwd();
  process.env.TERMYTE_HOOK_PATH = join(projectRoot, "src", "cli", "hook.ts");
  process.env.TERMYTE_MCP_PATH = join(projectRoot, "src", "mcp", "server.ts");
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  delete process.env.TERMYTE_HOOK_PATH;
  delete process.env.TERMYTE_MCP_PATH;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("installers", () => {
  it("lists supported platforms", () => {
    const list = listSupportedPlatforms();
    expect(list).toContain("claude-code");
    expect(list).toContain("codex");
    expect(list).toEqual(["claude-code", "codex"]);
  });

  it("installs Claude Code hooks to ~/.claude/settings.json", () => {
    const code = installFor("claude-code", { target: "user", homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".claude", "settings.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.SessionStart).toBeDefined();
    expect(parsed.hooks.PostToolUse).toBeDefined();
    const cmd = parsed.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain("claude-code");
    expect(cmd).toContain("session-init");
  });

  it("installs Codex hooks to ~/.codex/hooks.json", () => {
    const code = installFor("codex", { target: "user", homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".codex", "hooks.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain("codex context");
    expect(parsed.hooks.PreToolUse).toBeUndefined();
  });

  it("preserves existing settings when re-installing", () => {
    const claudePath = join(homeDir, ".claude", "settings.json");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(claudePath, JSON.stringify({ theme: "dark", hooks: {} }, null, 2));
    const code = installFor("claude-code", { target: "user", homeDir });
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(claudePath, "utf-8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.hooks.SessionStart).toBeDefined();
  });

  it("returns 1 for an unknown platform", () => {
    expect(installFor("not-a-real-ide", { homeDir })).toBe(1);
  });

});
