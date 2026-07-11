/**
 * Per-IDE installer dispatch. The `termyte install <platform>` CLI
 * command calls into this module.
 */
import { installClaudeCodeHooks } from "./claude-code.js";
import { installCodexHooks } from "./codex.js";

export type SupportedPlatform = "claude-code" | "codex";

export function listSupportedPlatforms(): string[] {
  return ["claude-code", "codex"];
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
    case "codex":
      return installCodexHooks({ target, homeDir: home });
    default: {
      process.stderr.write(`termyte: unknown platform '${platform}'.\n`);
      process.stderr.write(`  Supported: ${listSupportedPlatforms().join(", ")}\n`);
      return 1;
    }
  }
}
