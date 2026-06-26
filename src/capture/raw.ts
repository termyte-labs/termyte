/**
 * Raw / generic adapter. Pass-through for any agent whose payload
 * already matches the NormalizedEvent field names. Used as the default
 * `adapterFor` fallback.
 */
import type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
import { isObject, pickString } from "./util.js";
import { AdapterRejectedInput, isValidCwd } from "./errors.js";
import { passthroughFormatOutput } from "./adapter.js";

export class RawAdapter implements PlatformAdapter {
  readonly name = "raw" as PlatformAdapter["name"];

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    const session_id = pickString(r, ["sessionId", "session_id"]) ?? "raw-unknown";
    const timestamp = typeof r["timestamp"] === "number" ? r["timestamp"] : Date.now();

    const cwd = pickString(r, ["cwd"]) ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput("invalid_cwd");
    }

    const tool_name = pickString(r, ["toolName", "tool_name"]);
    const tool_input = r["toolInput"] ?? r["tool_input"] ?? null;
    const tool_output = r["toolResponse"] ?? r["tool_response"] ?? null;
    const user_prompt = pickString(r, ["prompt"]);
    const final_response = pickString(r, ["last_assistant_message"]);

    let event_type: NormalizedEvent["event_type"];
    if (user_prompt !== null) event_type = "user_prompt";
    else if (final_response !== null) event_type = "assistant_message";
    else if (tool_name) event_type = "tool_use";
    else return null;

    return {
      session_id,
      timestamp,
      event_type,
      tool_name,
      tool_input,
      tool_output,
      files_read: null,
      files_modified: null,
      user_prompt,
      final_response,
      cwd,
    };
  }

  formatOutput(result: HookResult): unknown {
    return passthroughFormatOutput(result);
  }
}
