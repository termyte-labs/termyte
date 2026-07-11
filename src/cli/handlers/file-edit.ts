/**
 * `file-edit` handler — PostToolUse on Edit/Write. After a file is
 * modified, Termyte can surface file-scoped knowledge for that file so
 * the agent sees relevant conventions, prior fixes, or warnings right
 * after making a change.
 */
import type { EventHandler } from "../handler-types.js";
import type { ContextBuilder } from "../../context/builder.js";
import type { Store } from "../../storage/store.js";

export function makeFileEditHandler(deps: { store: Store; builder: ContextBuilder }): EventHandler {
  return async ({ event }) => {
    if (event.event_type !== "tool_use" || !event.tool_name) {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
    if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(event.tool_name)) {
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
        maxMemories: 6,
        surface: "file-edit",
      });
      if (context.rankedMemories.length === 0 && context.observations.length === 0) {
        return { handled: true, result: { continue: true, suppressOutput: true } };
      }
      const contextText = context.text.trim();
      const lines = [
        `After editing ${file}, Termyte found related knowledge:`,
        "",
        contextText.length > 0 ? contextText : "(no related knowledge yet)",
      ];
      return {
        handled: true,
        result: {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: lines.join("\n"),
            contextInjectionId: context.contextInjectionId,
          },
        },
      };
    } catch {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
  };
}

function pickFile(event: { tool_input: unknown }): string | null {
  if (!event.tool_input || typeof event.tool_input !== "object") return null;
  const ti = event.tool_input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "filename", "file"]) {
    const value = ti[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
