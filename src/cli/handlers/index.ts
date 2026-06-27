/**
 * Handler dispatch. Unknown event names return a no-op rather than
 * throwing — a typo in a hook config should never crash the agent.
 */
import type { EventHandler, EventHandlerName } from "../handler-types.js";
import { makeContextHandler } from "./context.js";
import { makeSessionInitHandler } from "./session-init.js";
import { observationHandler } from "./observation.js";
import { makeSummarizeHandler } from "./summarize.js";
import { fileEditHandler } from "./file-edit.js";
import { makeFileContextHandler } from "./file-context.js";
import type { Store } from "../../storage/store.js";
import type { HybridSearch } from "../../retrieval/hybrid.js";
import type { ContextBuilder } from "../../context/builder.js";

export type { EventHandler, EventHandlerName, HandlerInput, HandlerOutput } from "../handler-types.js";

export interface HandlerDeps {
  store: Store;
  search: HybridSearch | null;
  builder: ContextBuilder | null;
}

export function buildHandlers(deps: HandlerDeps): Record<EventHandlerName, EventHandler> {
  return {
    "context":      makeContextHandler(deps),
    "session-init": makeSessionInitHandler(deps),
    "observation":  observationHandler,
    "summarize":    makeSummarizeHandler(deps),
    "file-edit":    fileEditHandler,
    "file-context": makeFileContextHandler(deps),
  };
}

export function getHandler(name: string, deps: HandlerDeps): EventHandler {
  const table = buildHandlers(deps);
  const known = (table as Record<string, EventHandler | undefined>)[name];
  if (!known) {
    return async () => ({ handled: false, result: { continue: true, suppressOutput: true } });
  }
  return known;
}
