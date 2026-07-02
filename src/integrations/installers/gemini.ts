/**
 * Install termyte hooks for Gemini CLI.
 *
 * Gemini CLI reads `~/.gemini/settings.json`. Its `hooks` key maps
 * event names (SessionStart / BeforeAgent / AfterAgent / BeforeTool /
 * AfterTool / PreCompress / Notification) to hook groups.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getTermyteHookPath, shellEscapePath } from "../install-paths.js";

interface GeminiHookEntry { name: string; type: "command"; command: string; timeout?: number; }
interface GeminiHookGroup { matcher?: string; hooks: GeminiHookEntry[]; }
interface GeminiHooksConfig { hooks?: Record<string, GeminiHookGroup[]>; [k: string]: unknown; }
interface GeminiSettings { hooks?: Record<string, GeminiHookGroup[]>; [k: string]: unknown; }

const HOOK_NAME = "termyte";
const HOOK_TIMEOUT_MS = 10_000;

const GEMINI_EVENT_TO_COMMAND: Record<string, string> = {
  SessionStart: "session-init",
  BeforeAgent:  "session-init",
  AfterAgent:   "summarize",
  BeforeTool:   "file-context",
  AfterTool:    "observation",
  PreCompress:  "summarize",
  Notification: "observation",
};

export function installGeminiHooks(homeDirOverride?: string): number {
  const hookPath = getTermyteHookPath();
  if (!hookPath) {
    process.stderr.write("termyte: could not locate the termyte-hook entry script.\n");
    return 1;
  }

  const home = homeDirOverride ?? homedir();
  const settingsPath = join(home, ".gemini", "settings.json");
  const escaped = shellEscapePath(hookPath);

  const existing: GeminiSettings = existsSync(settingsPath)
    ? safeReadJson(settingsPath) : {};
  if (!existing.hooks) existing.hooks = {};

  for (const [event, cmd] of Object.entries(GEMINI_EVENT_TO_COMMAND)) {
    const fullCmd = `node "${escaped}" gemini-cli ${cmd}`;
    const group: GeminiHookGroup = {
      matcher: "*",
      hooks: [{ name: HOOK_NAME, type: "command", command: fullCmd, timeout: HOOK_TIMEOUT_MS }],
    };
    const list = existing.hooks[event] ?? [];
    const filtered = list.filter((g) => !g.hooks.some((h) => h.name === HOOK_NAME));
    existing.hooks[event] = [...filtered, group];
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  process.stdout.write(`termyte: wrote Gemini hooks to ${settingsPath}\n`);
  process.stdout.write(`termyte: hooks capture traces and automatically start a background worker that processes them into memories (requires TERMYTE_LLM_API_KEY).\n`);
  process.stdout.write(`termyte: set TERMYTE_AUTO_WORKER=0 to disable, or run 'termyte synth' to generate observations via the agent CLI.\n`);
  process.stdout.write(`termyte: note: 'termyte synth' with Gemini is rate-limited to the free tier (60 req/min, 1000 req/day).\n`);
  return 0;
}

function safeReadJson(p: string): GeminiSettings {
  try { return JSON.parse(readFileSync(p, "utf-8")) as GeminiSettings; }
  catch { return {}; }
}
