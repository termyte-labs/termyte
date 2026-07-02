/** `summarize` handler — enqueue summary work without running an LLM in the hook. */
import type { EventHandler } from "../handler-types.js";
import type { Store } from "../../storage/store.js";
import type { Observer } from "../../observer/pipeline.js";
import { buildSummaryPrompt, type SessionForPrompt } from "../../observer/prompts.js";

export function makeSummarizeHandler(deps: { store: Store; observer: Observer }): EventHandler {
  return async ({ event }) => {
    if (event.event_type === "session_end" || event.event_type === "assistant_message") {
      const traces = deps.store.getTracesForSession(event.session_id, 200);
      const files = new Set<string>();
      const userPrompts: string[] = [];
      let finalResponse: string | null = null;
      for (const trace of traces) {
        if (trace.user_prompt) userPrompts.push(trace.user_prompt);
        if (trace.final_response) finalResponse = trace.final_response;
        if (trace.files_modified) {
          for (const file of trace.files_modified) files.add(file);
        }
      }
      const input: SessionForPrompt = {
        user_prompts: userPrompts,
        final_response: finalResponse,
        files_modified: [...files],
      };
      await deps.observer.generateSummary(event.session_id, input);
    }
    return { handled: true, result: { continue: true, suppressOutput: true } };
  };
}

export { buildSummaryPrompt };
