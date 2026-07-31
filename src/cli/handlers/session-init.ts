/**
 * `session-init` handler — SessionStart / BeforeAgent. Records the
 * session and (optionally) returns context for the first turn.
 */
import type { EventHandler } from "../handler-types.js";
import type { Store } from "../../storage/store.js";
import type { HybridSearch } from "../../retrieval/hybrid.js";
import type { ContextBuilder } from "../../context/builder.js";

export function makeSessionInitHandler(deps: { store: Store; search: HybridSearch; builder: ContextBuilder }): EventHandler {
  return async (input) => {
    if (input.event.event_type !== "session_init") return { handled: false, result: { continue: true, suppressOutput: true } };
    const session = deps.store.getSession(input.event.session_id);
    const task = session?.repo_id
      ? deps.store.getDB().prepare(`SELECT objective FROM tasks WHERE repo_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`).get(session.repo_id) as { objective?: string } | undefined
      : undefined;
    const result = await deps.builder.build({
      repo_id: session?.repo_id ?? undefined,
      query: task?.objective,
      sessionId: input.event.session_id,
      agent: "coding-agent",
      surface: "session-init",
      tokenBudget: 2_500,
      maxMemories: 8,
    });
    if (!result.text.trim()) return { handled: true, result: { continue: true, suppressOutput: true } };
    return {
      handled: true,
      result: {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `${result.text}\nContext injection: ${result.contextInjectionId ?? "none"}`,
          contextInjectionId: result.contextInjectionId ?? undefined,
        },
      },
    };
  };
}
