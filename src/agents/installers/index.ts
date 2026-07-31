/**
 * Per-IDE installer dispatch. The `termyte install <platform>` CLI
 * command calls into this module.
 */
import { installClaudeCodeHooks } from "./claude-code.js";
import { installCodexHooks } from "./codex.js";
import { installOpenCode } from "./opencode.js";

export type SupportedPlatform = "claude-code" | "codex" | "opencode";

export function listSupportedPlatforms(): string[] {
  return ["claude-code", "codex", "opencode"];
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
    case "opencode":
      if (target === "project") {
        process.stderr.write("termyte: OpenCode installation currently supports only the user target.\n");
        return 1;
      }
      return installOpenCode({ homeDir: home });
    default: {
      process.stderr.write(`termyte: unknown platform '${platform}'.\n`);
      process.stderr.write(`  Supported: ${listSupportedPlatforms().join(", ")}\n`);
      return 1;
    }
  }
}
