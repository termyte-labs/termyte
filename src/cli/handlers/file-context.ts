/**
 * `file-context` handler — PreToolUse on Read. Searches the corpus for
 * memories tied to the file the agent is about to read, and injects
 * them as `additionalContext` so the agent starts with prior knowledge.
 */
import type { EventHandler } from "../handler-types.js";
import type { ContextBuilder } from "../../context/builder.js";

export function makeFileContextHandler(deps: { store: import("../../storage/store.js").Store; builder: ContextBuilder }): EventHandler {
  return async ({ event }) => {
    if (event.event_type !== "tool_use" || !event.tool_name) {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
    if (!["Read", "Edit", "Write", "Glob", "Grep"].includes(event.tool_name)) {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
    const file = pickFile(event);
    if (!file) {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
    try {
      const session = deps.store.getSession(event.session_id);
      const context = await deps.builder.build({
        query: file,
        repo_id: session?.repo_id ?? undefined,
        sessionId: event.session_id,
        currentFiles: [file],
        maxMemories: 8,
        surface: "file-context",
      });
      if (context.rankedMemories.length === 0) {
        return { handled: true, result: { continue: true, suppressOutput: true } };
      }
      return {
        handled: true,
        result: {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: `Prior knowledge for ${file}:\n\n${context.text}\nContext injection: ${context.contextInjectionId}`,
            contextInjectionId: context.contextInjectionId!,
          },
        },
      };
    } catch {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
  };
}

function pickFile(event: { tool_name: string | null; tool_input: unknown }): string | null {
  if (!event.tool_input || typeof event.tool_input !== "object") return null;
  const ti = event.tool_input as Record<string, unknown>;
  for (const k of ["file_path", "filePath", "path", "pattern"]) {
    const v = ti[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
