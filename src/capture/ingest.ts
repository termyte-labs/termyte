import type { Store } from "../storage/store.js";
import type { Trace } from "../core/types.js";
import type { NormalizedEvent } from "./adapter.js";
import { extractFilesFromEvent } from "./files.js";

/**
 * Convert a normalized event into a trace, upsert the session, and
 * insert the trace row. Returns the persisted trace (with its assigned
 * id).
 */
export class Ingestor {
  constructor(private store: Store) {}

  ingest(event: NormalizedEvent): Trace {
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

    // Ensure the session row exists.
    this.store.upsertSession(event.session_id, "unknown");

    const trace = this.store.insertTrace({
      session_id: event.session_id,
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

    return trace;
  }
}
