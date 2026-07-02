/**
 * Install termyte hooks for the Codex CLI.
 *
 * Codex reads `~/.codex/hooks.json` (or the per-project
 * `<project>/.codex/hooks.json`). Its event names mirror Claude Code's.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getTermyteHookPath, shellEscapePath } from "../install-paths.js";

interface CodexHookEntry { type: "command"; command: string; timeout?: number; }
interface CodexHookGroup { matcher?: string; hooks: CodexHookEntry[]; }
interface CodexHooksConfig { hooks?: Record<string, CodexHookGroup[]>; [k: string]: unknown; }

const HOOK_EVENTS: Array<{ event: string; command: string; timeout: number }> = [
  { event: "SessionStart",      command: "session-init",  timeout: 60 },
  { event: "UserPromptSubmit",  command: "context",       timeout: 30 },
  { event: "PreToolUse",        command: "file-context",  timeout: 30 },
  { event: "PostToolUse",       command: "observation",   timeout: 60 },
];

export interface CodexInstallOptions { target: "user" | "project"; homeDir?: string; }

export function installCodexHooks(opts: CodexInstallOptions): number {
  const hookPath = getTermyteHookPath();
  if (!hookPath) {
    process.stderr.write("termyte: could not locate the termyte-hook entry script.\n");
    return 1;
  }

  const home = opts.homeDir ?? homedir();
  const hooksPath = opts.target === "user"
    ? join(home, ".codex", "hooks.json")
    : join(process.cwd(), ".codex", "hooks.json");

  const escaped = shellEscapePath(hookPath);
  const existing: CodexHooksConfig = existsSync(hooksPath)
    ? safeReadJson(hooksPath) : {};
  if (!existing.hooks) existing.hooks = {};

  for (const e of HOOK_EVENTS) {
    const cmd = `node "${escaped}" codex ${e.command}`;
    const group: CodexHookGroup = {
      matcher: "*",
      hooks: [{ type: "command", command: cmd, timeout: e.timeout * 1000 }],
    };
    const list = existing.hooks[e.event] ?? [];
    const filtered = list.filter((g) => !g.hooks.some((h) => h.command.includes("termyte-hook")));
    existing.hooks[e.event] = [...filtered, group];
  }

  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  process.stdout.write(`termyte: wrote Codex hooks to ${hooksPath}\n`);
  process.stdout.write(`termyte: hooks capture traces and automatically start a background worker that processes them into memories (requires TERMYTE_LLM_API_KEY).\n`);
  process.stdout.write(`termyte: set TERMYTE_AUTO_WORKER=0 to disable, or run 'termyte synth' to generate observations via the agent CLI.\n`);
  return 0;
}

function safeReadJson(p: string): CodexHooksConfig {
  try { return JSON.parse(readFileSync(p, "utf-8")) as CodexHooksConfig; }
  catch { return {}; }
}
