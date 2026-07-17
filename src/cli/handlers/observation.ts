/**
 * `observation` handler — PostToolUse / AfterTool / post_*_code /
 * post_run_command. After a tool finishes, Termyte can surface related
 * memory for the file or command that was just touched.
 */
import type { EventHandler } from "../handler-types.js";
import type { ContextBuilder } from "../../context/builder.js";
import type { Store } from "../../storage/store.js";
import { extractFilesFromEvent } from "../../capture/files.js";

const READ_AND_EDIT_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "DeleteFile",
  "MoveFile",
  "RenameFile",
  "ApplyPatch",
]);

export function makeObservationHandler(deps: { store: Store; builder: ContextBuilder }): EventHandler {
  return async ({ event }) => {
    if (event.event_type !== "tool_use" || !event.tool_name) {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
    if (!READ_AND_EDIT_TOOLS.has(event.tool_name)) {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }

    const session = deps.store.getSession(event.session_id);
    const files = extractFilesFromEvent(event.tool_name, event.tool_input, event.tool_output);
    const currentFiles = [...new Set([...files.read, ...files.modified])];
    if (currentFiles.length === 0) {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }

    try {
      const context = await deps.builder.build({
        query: currentFiles[0],
        repo_id: session?.repo_id ?? undefined,
        sessionId: event.session_id,
        currentFiles,
        maxMemories: 6,
        surface: "observation",
      });
      if (context.rankedMemories.length === 0 && context.observations.length === 0) {
        return { handled: true, result: { continue: true, suppressOutput: true } };
      }
      const contextText = context.text.trim();
      const lines = [
        `After ${event.tool_name} on ${currentFiles[0]}, Termyte found related knowledge:`,
        "",
        contextText.length > 0 ? contextText : "(no related knowledge yet)",
        `Context injection: ${context.contextInjectionId}`,
      ];
      return {
        handled: true,
        result: {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: lines.join("\n"),
            contextInjectionId: context.contextInjectionId!,
          },
        },
      };
    } catch {
      return { handled: true, result: { continue: true, suppressOutput: true } };
    }
  };
}
