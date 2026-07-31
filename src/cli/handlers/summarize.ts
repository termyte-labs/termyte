/** `summarize` handler — enqueue summary work without running an LLM in the hook. */
import type { EventHandler } from "../handler-types.js";
import type { Observer } from "../../observer/pipeline.js";

export function makeSummarizeHandler(deps: { observer: Observer; disabled?: boolean }): EventHandler {
  return async ({ event }) => {
    if (deps.disabled) return { handled: event.event_type === "session_end" || event.event_type === "assistant_message", result: { continue: true, suppressOutput: true } };
    if (event.event_type === "session_end" || event.event_type === "assistant_message") {
      deps.observer.enqueueSummary(event.session_id);
    }
    return { handled: true, result: { continue: true, suppressOutput: true } };
  };
}
