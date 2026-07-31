/**
 * Codex CLI hook payload adapter.
 *
 * Codex native hooks emit a JSON object with the same shape as Claude
 * Code's, plus an optional `hook_event_name` field that names the event
 * (SessionStart, UserPromptSubmit, PostToolUse, etc.) and bash commands
 * that are parsed for actual file paths.
 *
 * See claude-mem `src/cli/adapters/codex.ts:59-103` and
 * `src/cli/adapters/codex-file-context.ts`.
 */
import type { PlatformAdapter, NormalizedEvent, HookResult } from "../../capture/adapter.js";
import type { EventType } from "../../shared/types.js";
import { isObject, pickString } from "../../capture/util.js";
import { extractCodexFilePaths } from "./codex-file-context.js";
import { AdapterRejectedInput, isValidCwd } from "../../capture/errors.js";

export class CodexAdapter implements PlatformAdapter {
  readonly name = "codex" as const;

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    const session_id = pickString(r, ["session_id", "sessionId"]);
    if (!session_id) return null;

    const timestamp = typeof r["timestamp"] === "number"
      ? (r["timestamp"] as number)
      : Date.now();

    const cwd = pickString(r, ["cwd"]) ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput("invalid_cwd");
    }

    const tool_name = pickString(r, ["tool_name", "toolName"]);
    let tool_input = (r["tool_input"] ?? r["toolInput"]) ?? null;
    const tool_output = r["tool_response"] ?? r["tool_output"] ?? r["toolOutput"] ?? null;

    // Codex PreToolUse on Bash: try to extract real file paths from the
    // shell command via shell-quote. Only paths that exist on disk are
    // returned; the original tool_input is left untouched for the agent.
    if (pickString(r, ["hook_event_name"]) === "PreToolUse" && tool_name === "Bash") {
      const paths = extractCodexFilePaths(tool_name, tool_input, cwd);
      if (paths.length > 0 && isObject(tool_input)) {
        tool_input = { ...(tool_input as Record<string, unknown>), filePaths: paths };
      }
    }

    let event_type: EventType;
    let user_prompt: string | null = null;
    let final_response: string | null = null;

    if (r["prompt"] !== undefined) {
      event_type = "user_prompt";
      user_prompt = pickString(r, ["prompt"]);
    } else if (r["last_assistant_message"] !== undefined) {
      event_type = "assistant_message";
      final_response = pickString(r, ["last_assistant_message"]);
    } else if (r["hook_event_name"] === "SessionStart") {
      event_type = "session_init";
    } else if (r["hook_event_name"] === "SessionEnd") {
      event_type = "session_end";
    } else if (tool_name) {
      event_type = "tool_use";
    } else {
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
    const out: Record<string, unknown> = {};
    if (result.continue !== undefined) out.continue = result.continue;
    if (result.systemMessage) out.systemMessage = result.systemMessage;
    if (result.decision === "block") out.decision = "block";
    if (result.reason) out.reason = result.reason;

    const hookSpecific = result.hookSpecificOutput;
    const eventName = hookSpecific?.hookEventName;
    if (!hookSpecific || !eventName || eventName === "Stop") return out;

    const specific: Record<string, unknown> = { hookEventName: eventName };
    if (hookSpecific.additionalContext) {
      specific.additionalContext = hookSpecific.additionalContext;
    }
    if (eventName === "PreToolUse") {
      if (hookSpecific.permissionDecision === "deny") {
        specific.permissionDecision = "deny";
        if (hookSpecific.permissionDecisionReason) {
          specific.permissionDecisionReason = hookSpecific.permissionDecisionReason;
        }
      }
      if (hookSpecific.updatedInput) {
        specific.updatedInput = hookSpecific.updatedInput;
      }
    }
    out.hookSpecificOutput = specific;
    return out;
  }
}
