/**
 * Install termyte hooks for Windsurf.
 *
 * Windsurf reads `~/.codeium/windsurf/hooks.json`. Its hook events are
 * action-based: pre_user_prompt, post_write_code, post_run_command,
 * post_mcp_tool_use, post_cascade_response.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getTermyteHookPath, shellEscapePath } from "../install-paths.js";

interface WindsurfHookEntry { command: string; show_output?: boolean; working_directory?: string; }
interface WindsurfHooksConfig { hooks?: Record<string, WindsurfHookEntry[]>; [k: string]: unknown; }

const WINDSURF_EVENT_TO_COMMAND: Record<string, string> = {
  pre_user_prompt:      "context",
  post_write_code:      "file-edit",
  post_run_command:     "observation",
  post_mcp_tool_use:    "observation",
  post_cascade_response: "summarize",
};

export function installWindsurfHooks(homeDirOverride?: string): number {
  const hookPath = getTermyteHookPath();
  if (!hookPath) {
    process.stderr.write("termyte: could not locate the termyte-hook entry script.\n");
    return 1;
  }

  const home = homeDirOverride ?? homedir();
  const hooksPath = join(home, ".codeium", "windsurf", "hooks.json");
  const escaped = shellEscapePath(hookPath);
  const wd = process.cwd();

  const existing: WindsurfHooksConfig = existsSync(hooksPath)
    ? safeReadJson(hooksPath) : { hooks: {} };
  if (!existing.hooks) existing.hooks = {};

  for (const [event, cmd] of Object.entries(WINDSURF_EVENT_TO_COMMAND)) {
    const fullCmd = `node "${escaped}" windsurf ${cmd}`;
    const entry: WindsurfHookEntry = { command: fullCmd, show_output: false, working_directory: wd };
    const list = existing.hooks[event] ?? [];
    const filtered = list.filter((h) => !h.command.includes("termyte-hook"));
    existing.hooks[event] = [...filtered, entry];
  }

  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  process.stdout.write(`termyte: wrote Windsurf hooks to ${hooksPath}\n`);
  process.stdout.write(`termyte: note — Windsurf has no synthesis CLI. Trace capture is enabled; run 'termyte synth' manually to synthesize.\n`);
  return 0;
}

function safeReadJson(p: string): WindsurfHooksConfig {
  try { return JSON.parse(readFileSync(p, "utf-8")) as WindsurfHooksConfig; }
  catch { return { hooks: {} }; }
}
