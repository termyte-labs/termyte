/**
 * Windsurf hook payload adapter.
 *
 * Windsurf's hooks are dispatched by `agent_action_name` rather than
 * per-event-type matchers. The five action types we care about:
 *   - pre_user_prompt   → user_prompt
 *   - post_write_code   → tool_use (Write)
 *   - post_run_command  → tool_use (Bash)
 *   - post_mcp_tool_use → tool_use (mcp_tool)
 *   - post_cascade_response → assistant_message
 *
 * See claude-mem `src/cli/adapters/windsurf.ts:1-71`.
 */
import type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
import { isObject, pickString } from "./util.js";
import { AdapterRejectedInput, isValidCwd } from "./errors.js";
import { passthroughFormatOutput } from "./adapter.js";

export class WindsurfAdapter implements PlatformAdapter {
  readonly name = "windsurf" as PlatformAdapter["name"];

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;
    const toolInfo = isObject(r["tool_info"]) ? r["tool_info"] : {};
    const actionName = typeof r["agent_action_name"] === "string" ? r["agent_action_name"] : "";

    const cwd = pickString(toolInfo, ["cwd"])
      ?? pickString(r, ["cwd"])
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput("invalid_cwd");
    }

    const session_id = pickString(r, ["trajectory_id", "execution_id", "session_id"]);
    if (!session_id) return null;
    const timestamp = typeof r["timestamp"] === "number" ? r["timestamp"] : Date.now();

    let tool_name: string | null = null;
    let tool_input: unknown = null;
    let tool_output: unknown = null;
    let user_prompt: string | null = null;
    let final_response: string | null = null;
    let event_type: NormalizedEvent["event_type"];

    switch (actionName) {
      case "pre_user_prompt":
        event_type = "user_prompt";
        user_prompt = pickString(toolInfo, ["user_prompt"]);
        break;
      case "post_write_code":
        event_type = "tool_use";
        tool_name = "Write";
        tool_input = {
          file_path: toolInfo["file_path"],
          edits: toolInfo["edits"],
        };
        break;
      case "post_run_command":
        event_type = "tool_use";
        tool_name = "Bash";
        tool_input = { command: toolInfo["command_line"] };
        break;
      case "post_mcp_tool_use":
        event_type = "tool_use";
        tool_name = (typeof toolInfo["mcp_tool_name"] === "string" ? toolInfo["mcp_tool_name"] : null) ?? "mcp_tool";
        tool_input = toolInfo["mcp_tool_arguments"];
        tool_output = toolInfo["mcp_result"];
        break;
      case "post_cascade_response":
        event_type = "assistant_message";
        tool_name = "cascade_response";
        tool_output = toolInfo["response"];
        break;
      default:
        return null;
    }

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
