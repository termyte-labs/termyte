/**
 * `file-context` handler — PreToolUse on Read. Searches the corpus for
 * memories tied to the file the agent is about to read, and injects
 * them as `additionalContext` so the agent starts with prior knowledge.
 */
import type { EventHandler } from "../handler-types.js";
import type { HybridSearch } from "../../retrieval/hybrid.js";
import type { ContextBuilder } from "../../context/builder.js";
import { renderHybridResults } from "../../context/builder.js";

export function makeFileContextHandler(deps: { search: HybridSearch | null; builder: ContextBuilder | null }): EventHandler {
  return async ({ event }) => {
    if (!deps.search) return { handled: true, result: { continue: true, suppressOutput: true } };
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
      const results = await deps.search.search({ query: file, limit: 8, currentFiles: [file] });
      if (results.length === 0) {
        return { handled: true, result: { continue: true, suppressOutput: true } };
      }
      const text = renderHybridResults(results);
      return {
        handled: true,
        result: {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: `Prior knowledge for ${file}:\n\n${text}`,
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
