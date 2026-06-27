/**
 * `summarize` handler — Stop / PreCompress / session.idle.
 *
 * On session end, the handler:
 *   1. Generates a session summary through the in-process LLM
 *      observer (preserves the existing behavior for users with a
 *      dedicated LLM configured).
 *   2. Fires `termyte-synth --session <id>` as a fire-and-forget
 *      background process to synthesize observations + memories
 *      from any remaining unprocessed traces.
 *
 * The hook is best-effort: any error is logged to stderr but the
 * hook itself returns a no-op so the agent is never blocked.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type { EventHandler } from "../handler-types.js";
import type { Store } from "../../storage/store.js";
import type { Observer } from "../../observer/pipeline.js";
import { buildSummaryPrompt, type SessionForPrompt } from "../../observer/prompts.js";

export function makeSummarizeHandler(deps: { store: Store; observer: Observer }): EventHandler {
  return async ({ event }) => {
    if (event.event_type === "session_end" || event.event_type === "assistant_message") {
      try {
        const traces = deps.store.getTracesForSession(event.session_id, 200);
        const files = new Set<string>();
        const userPrompts: string[] = [];
        let finalResponse: string | null = null;
        for (const t of traces) {
          if (t.user_prompt) userPrompts.push(t.user_prompt);
          if (t.final_response) finalResponse = t.final_response;
          if (t.files_modified) for (const f of t.files_modified) files.add(f);
        }
        const promptInput: SessionForPrompt = {
          user_prompts: userPrompts,
          final_response: finalResponse,
          files_modified: [...files],
        };
        await deps.observer.generateSummary(event.session_id, promptInput);
      } catch (err) {
        process.stderr.write(`termyte: summarize failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      // After the in-process summary, fire the background synthesizer
      // for this session. We do not await — the agent is already
      // done and the hook must return immediately.
      fireTermyteSynth(event.session_id, event.cwd);
    }
    return { handled: true, result: { continue: true, suppressOutput: true } };
  };
}

/**
 * Spawn `termyte-synth --session <id>` as a detached background process
 * and return immediately. Failures are logged to stderr but never
 * propagate to the caller.
 *
 * Three safety nets:
 *   1. We only fire when a built `dist/cli/synth.js` is present, or
 *      when TERMYTE_SYNTH_PATH is set. We deliberately do not
 *      auto-spawn the `.ts` source — running TypeScript directly
 *      requires a loader and a stable Node path; in production the
 *      user has run `npm run build`.
 *   2. We pass `--timeout-ms` to the synth subprocess, capped to
 *      `TERMYTE_SYNTH_TIMEOUT_MS` (default 5 min). The agent's
 *      SessionEnd hook usually has a 60 s timeout, so capping the
 *      synth run at 5 min prevents orphaned processes from eating
 *      quota long after the agent has moved on.
 *   3. We record the child's PID to `~/.termyte/synth.pid`. The
 *      next `termyte-synth` start reads the file and kills the
 *      recorded PID if it's still alive — a reaper for orphans
 *      from a previous crashed session.
 */
function fireTermyteSynth(sessionId: string, cwd: string): void {
  const candidates = [
    process.env.TERMYTE_SYNTH_PATH,
    resolvePath(process.cwd(), "dist", "cli", "synth.js"),
  ];
  const entry = candidates.find((p) => p && existsSync(p));
  if (!entry) return; // silently skip — user runs termyte-synth manually

  // Reap any orphan from a previous crashed session.
  reapOrphanSynth();

  // Some Windows / nvm4w environments have a path with a literal
  // "\n" that confuses spawn's path parser. Guard against the
  // resulting ENOENT so it surfaces as a warning, not an
  // unhandled exception in the host process.
  const execPath = process.execPath;
  if (typeof execPath !== "string" || execPath.includes("\n") || execPath.includes("\r")) {
    process.stderr.write("termyte: skipping termyte-synth spawn (process.execPath is malformed)\n");
    return;
  }

  const timeoutMs = Math.max(60_000, parseInt(process.env.TERMYTE_SYNTH_TIMEOUT_MS ?? "300000", 10));
  const args = [entry, "--session", sessionId, "--once", "--timeout-ms", String(timeoutMs)];
  try {
    const child = spawn(execPath, args, {
      cwd,
      stdio: "ignore",
      windowsHide: true,
      detached: true,
      env: process.env,
    });
    child.on("error", () => { /* swallow — best-effort fire-and-forget */ });
    // Record the PID so the next start can reap it.
    recordSynthPid(child.pid);
    // Reaper: if the child is still alive after timeout + 5s grace,
    // kill it. unref() so the reaper itself doesn't keep the host alive.
    setTimeout(() => {
      try { child.kill(); } catch { /* already dead */ }
    }, timeoutMs + 5_000).unref();
    child.unref();
  } catch (err) {
    process.stderr.write(`termyte: failed to spawn termyte-synth: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

const PID_FILE = join(homedir(), ".termyte", "synth.pid");

function recordSynthPid(pid: number | undefined): void {
  if (!pid || !Number.isFinite(pid)) return;
  try {
    mkdirSync(dirname(PID_FILE), { recursive: true });
    writeFileSync(PID_FILE, String(pid), "utf-8");
  } catch { /* best-effort */ }
}

function reapOrphanSynth(): void {
  if (!existsSync(PID_FILE)) return;
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      return;
    }
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  } catch { /* best-effort */ }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

// Re-export buildSummaryPrompt so the worker / hook can compose prompts
// without reaching into prompts.ts directly.
export { buildSummaryPrompt };
