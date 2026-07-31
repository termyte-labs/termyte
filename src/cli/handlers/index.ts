/**
 * Handler dispatch. Unknown event names return a no-op rather than
 * throwing — a typo in a hook config should never crash the agent.
 */
import type { EventHandler, EventHandlerName } from "../handler-types.js";
import { makeContextHandler } from "./context.js";
import { makeSessionInitHandler } from "./session-init.js";
import { makeObservationHandler } from "./observation.js";
import { makeSummarizeHandler } from "./summarize.js";
import { makeFileEditHandler } from "./file-edit.js";
import { makeFileContextHandler } from "./file-context.js";
import type { Store } from "../../storage/store.js";
import type { HybridSearch } from "../../retrieval/hybrid.js";
import type { ContextBuilder } from "../../context/builder.js";
import type { Observer } from "../../observer/pipeline.js";

export type { EventHandler, EventHandlerName, HandlerInput, HandlerOutput } from "../handler-types.js";

export interface HandlerDeps {
  store: Store;
  search: HybridSearch;
  builder: ContextBuilder;
  observer: Observer;
  sessionConsolidation?: boolean;
}

export function buildHandlers(deps: HandlerDeps): Record<EventHandlerName, EventHandler> {
  return {
    "context":      makeContextHandler(deps),
    "session-init": makeSessionInitHandler(deps),
    "observation":  makeObservationHandler(deps),
    "summarize":    makeSummarizeHandler({ observer: deps.observer, disabled: deps.sessionConsolidation === true }),
    "file-edit":    makeFileEditHandler(deps),
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
