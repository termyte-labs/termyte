/**
 * `session-init` handler — SessionStart / BeforeAgent. Records the
 * session and (optionally) returns context for the first turn.
 */
import type { EventHandler } from "../handler-types.js";
import type { Store } from "../../storage/store.js";
import type { HybridSearch } from "../../retrieval/hybrid.js";
import type { ContextBuilder } from "../../context/builder.js";
import { makeContextHandler } from "./context.js";

export function makeSessionInitHandler(deps: { store: Store; search: HybridSearch; builder: ContextBuilder }): EventHandler {
  const inner = makeContextHandler(deps);
  return async (input) => {
    if (input.event.event_type !== "session_init") {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
    return await inner(input);
  };
}
