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
    expect(list).toContain("cursor");
    expect(list).toContain("codex");
    expect(list).toContain("gemini-cli");
    expect(list).toContain("windsurf");
    expect(list).toContain("mcp:copilot-cli");
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

  it("installs Cursor hooks to ~/.cursor/hooks.json", () => {
    const code = installFor("cursor", { target: "user", homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".cursor", "hooks.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.hooks.beforeSubmitPrompt[0].command).toContain("cursor context");
    expect(parsed.hooks.stop[0].command).toContain("cursor summarize");
  });

  it("installs Codex hooks to ~/.codex/hooks.json", () => {
    const code = installFor("codex", { target: "user", homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".codex", "hooks.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("codex file-context");
  });

  it("installs Gemini CLI hooks to ~/.gemini/settings.json", () => {
    const code = installFor("gemini-cli", { homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".gemini", "settings.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.hooks.SessionStart[0].hooks[0].name).toBe("termyte");
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain("gemini-cli session-init");
  });

  it("installs Windsurf hooks to ~/.codeium/windsurf/hooks.json", () => {
    const code = installFor("windsurf", { homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".codeium", "windsurf", "hooks.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.hooks.pre_user_prompt[0].command).toContain("windsurf context");
    expect(parsed.hooks.post_run_command[0].command).toContain("windsurf observation");
  });

  it("installs MCP server entry for Copilot CLI", () => {
    const code = installFor("mcp:copilot-cli", { homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".github", "copilot", "mcp.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.servers.termyte).toBeDefined();
    expect(parsed.servers.termyte.args).toEqual([process.env.TERMYTE_MCP_PATH]);
  });

  it("installs MCP server entry for Antigravity", () => {
    const code = installFor("mcp:antigravity", { homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".gemini", "antigravity", "mcp_config.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.mcpServers.termyte).toBeDefined();
  });

  it("installs Goose YAML config", () => {
    const code = installFor("mcp:goose", { homeDir });
    expect(code).toBe(0);
    const path = join(homeDir, ".config", "goose", "config.yaml");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("termyte:");
    expect(content).toContain(process.env.TERMYTE_MCP_PATH!);
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

  it("installs the OpenCode plugin and registers it in opencode.json", () => {
    // The OpenCode installer uses homedir() directly; override the
    // env vars that drive it.
    const beforeHome = process.env.HOME;
    const beforeUp = process.env.USERPROFILE;
    const beforeCfg = process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.OPENCODE_CONFIG_DIR = join(homeDir, ".config", "opencode");
    try {
      const code = installFor("opencode");
      expect(code).toBe(0);
      const pluginPath = join(homeDir, ".config", "opencode", "plugins", "termyte.js");
      const cfgPath = join(homeDir, ".config", "opencode", "opencode.json");
      expect(existsSync(pluginPath)).toBe(true);
      expect(existsSync(cfgPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      expect(cfg.plugin).toContain("./plugins/termyte.js");
    } finally {
      if (beforeHome === undefined) delete process.env.HOME;
      else process.env.HOME = beforeHome;
      if (beforeUp === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = beforeUp;
      if (beforeCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = beforeCfg;
    }
  });
});
