/**
 * `context` handler — called on session start / user prompt. Builds
 * a memory context from the recent corpus and returns it as
 * `additionalContext` for the agent's first turn.
 */
import type { EventHandler } from "../handler-types.js";
import type { Store } from "../../storage/store.js";
import type { HybridSearch } from "../../retrieval/hybrid.js";
import type { ContextBuilder } from "../../context/builder.js";

export function makeContextHandler(deps: { store: Store; search: HybridSearch; builder: ContextBuilder }): EventHandler {
  return async ({ event }) => {
    const session = deps.store.getSession(event.session_id);
    const repo_id = session?.repo_id ?? undefined;
    const result = await deps.builder.build({
      repo_id,
      maxMemories: 25,
      sessionId: event.session_id,
      surface: "hook",
    });
    if (!result.text || result.text.trim().length === 0) {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
    return {
      handled: true,
      result: {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: result.text,
        },
      },
    };
  };
}
