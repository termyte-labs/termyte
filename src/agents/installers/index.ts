import { installClaudeCodeHooks } from "./claude-code.js";
import { installCodexHooks } from "./codex.js";

export type SupportedPlatform = "claude-code" | "codex";
export interface InstallOptions { target?: "user" | "project"; homeDir?: string; }

export function installFor(platform: SupportedPlatform, options: InstallOptions = {}): number {
  const target = options.target ?? "project";
  return platform === "claude-code"
    ? installClaudeCodeHooks({ target, homeDir: options.homeDir })
    : installCodexHooks({ target, homeDir: options.homeDir });
}
