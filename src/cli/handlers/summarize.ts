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
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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
 * Only fires when a built `dist/cli/synth.js` is present, or when
 * TERMYTE_SYNTH_PATH is set. We deliberately do not auto-spawn the
 * `.ts` source — running TypeScript directly requires a loader and
 * a stable Node path; in production the user has run `npm run build`.
 */
function fireTermyteSynth(sessionId: string, cwd: string): void {
  const candidates = [
    process.env.TERMYTE_SYNTH_PATH,
    resolvePath(process.cwd(), "dist", "cli", "synth.js"),
  ];
  const entry = candidates.find((p) => p && existsSync(p));
  if (!entry) return; // silently skip — user runs termyte-synth manually
  try {
    const args = [entry, "--session", sessionId, "--once"];
    // Some Windows / nvm4w environments have a path with a literal
    // "\n" that confuses spawn's path parser. Guard against the
    // resulting ENOENT so it surfaces as a warning, not an
    // unhandled exception in the host process.
    const execPath = process.execPath;
    if (typeof execPath !== "string" || execPath.includes("\n") || execPath.includes("\r")) {
      process.stderr.write("termyte: skipping termyte-synth spawn (process.execPath is malformed)\n");
      return;
    }
    const child = spawn(execPath, args, {
      cwd,
      stdio: "ignore",
      windowsHide: true,
      detached: true,
      env: process.env,
    });
    child.on("error", () => { /* swallow — best-effort fire-and-forget */ });
    child.unref();
  } catch (err) {
    process.stderr.write(`termyte: failed to spawn termyte-synth: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// Re-export buildSummaryPrompt so the worker / hook can compose prompts
// without reaching into prompts.ts directly.
export { buildSummaryPrompt };
