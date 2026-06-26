/**
 * Per-IDE installer dispatch. The `termyte install <platform>` CLI
 * command calls into this module.
 */
import { installClaudeCodeHooks } from "./claude-code.js";
import { installCursorHooks } from "./cursor.js";
import { installCodexHooks } from "./codex.js";
import { installGeminiHooks } from "./gemini.js";
import { installWindsurfHooks } from "./windsurf.js";
import { installOpenCodePlugin } from "./opencode.js";
import { installMcpOnly, listMcpInstallerIds } from "./mcp-only.js";

export type SupportedPlatform =
  | "claude-code" | "cursor" | "codex" | "gemini-cli" | "windsurf"
  | "opencode"
  | "mcp:copilot-cli" | "mcp:antigravity" | "mcp:goose" | "mcp:roo-code" | "mcp:warp";

export function listSupportedPlatforms(): string[] {
  return [
    "claude-code", "cursor", "codex", "gemini-cli", "windsurf", "opencode",
    ...listMcpInstallerIds().map((id) => `mcp:${id}`),
  ];
}

export interface InstallOptions {
  target?: "user" | "project";
  /** Override `os.homedir()` for tests. */
  homeDir?: string;
}

export function installFor(platform: string, opts: InstallOptions = {}): number {
  const target = opts.target ?? "user";
  const home = opts.homeDir;
  switch (platform) {
    case "claude-code":
      return installClaudeCodeHooks({ target, homeDir: home });
    case "cursor":
      return installCursorHooks(target, home);
    case "codex":
      return installCodexHooks({ target, homeDir: home });
    case "gemini-cli":
      return installGeminiHooks(home);
    case "windsurf":
      return installWindsurfHooks(home);
    case "opencode":
      return installOpenCodePlugin();
    default: {
      if (platform.startsWith("mcp:")) {
        return installMcpOnly(platform.slice(4), home);
      }
      process.stderr.write(`termyte: unknown platform '${platform}'.\n`);
      process.stderr.write(`  Supported: ${listSupportedPlatforms().join(", ")}\n`);
      return 1;
    }
  }
}
