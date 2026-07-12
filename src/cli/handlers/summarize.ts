/** `summarize` handler — enqueue summary work without running an LLM in the hook. */
import type { EventHandler } from "../handler-types.js";
import type { Observer } from "../../observer/pipeline.js";

export function makeSummarizeHandler(deps: { observer: Observer }): EventHandler {
  return async ({ event }) => {
    if (event.event_type === "session_end" || event.event_type === "assistant_message") {
      deps.observer.enqueueSummary(event.session_id);
    }
    return { handled: true, result: { continue: true, suppressOutput: true } };
  };
}
