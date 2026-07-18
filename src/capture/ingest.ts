import type { Store } from "../storage/store.js";
import type { Trace } from "../core/types.js";
import type { NormalizedEvent } from "./adapter.js";
import { extractFilesFromEvent } from "./files.js";

/**
 * Convert a normalized event into a trace and insert the trace row.
 * Returns the persisted trace (with its assigned id).
 *
 * Note: The caller (HookRunner) is responsible for upserting the session
 * row before calling ingest. This avoids overwriting the session project
 * with "unknown".
 */
export class Ingestor {
  constructor(private store: Store) {}

  ingest(event: NormalizedEvent): { trace: Trace; inserted: boolean } {
    // Project resolution: if the adapter didn't extract files, try from input.
    let files_read = event.files_read;
    let files_modified = event.files_modified;
    if (
      event.tool_name &&
      (files_read === null || files_modified === null)
    ) {
      const f = extractFilesFromEvent(event.tool_name, event.tool_input, event.tool_output);
      files_read = files_read ?? (f.read.length > 0 ? f.read : null);
      files_modified = files_modified ?? (f.modified.length > 0 ? f.modified : null);
    }

    // Merge any pre-extracted file paths carried on the event (e.g. Codex
    // sets `tool_input.filePaths` after running shell-quote on the Bash
    // command). Only read-side files; the event itself owns modifications.
    if (event.tool_name === "Bash" && event.tool_input && typeof event.tool_input === "object") {
      const pre = (event.tool_input as Record<string, unknown>)["filePaths"];
      if (Array.isArray(pre) && (files_read === null || files_read.length === 0)) {
        const list = pre.filter((p): p is string => typeof p === "string" && p.length > 0);
        if (list.length > 0) files_read = list;
      }
    }

    return this.store.getDB().transaction(() => {
      const result = this.store.insertTraceIdempotent({
        session_id: event.session_id,
        platform_event_id: event.platform_event_id ?? null,
        timestamp: event.timestamp,
        event_type: event.event_type,
        tool_name: event.tool_name,
        tool_input: event.tool_input,
        tool_output: event.tool_output,
        files_read,
        files_modified,
        user_prompt: event.user_prompt,
        final_response: event.final_response,
      });
      if (result.inserted) this.store.projectTrace(result.trace, event.cwd);
      return result;
    })();

  }
}
