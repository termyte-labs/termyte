/**
 * `summarize` handler — Stop / PreCompress / session.idle. Kicks off
 * a session summary through the LLM observer. Synchronous to keep the
 * hook simple; the agent is already done.
 */
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
    }
    return { handled: true, result: { continue: true, suppressOutput: true } };
  };
}

// Re-export buildSummaryPrompt so the worker / hook can compose prompts
// without reaching into prompts.ts directly.
export { buildSummaryPrompt };
