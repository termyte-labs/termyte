/**
 * Cursor hook payload adapter.
 *
 * Cursor's hook protocol is shaped like Claude Code's but with a few
 * renames: `conversation_id` for the session, `workspace_roots` for
 * `cwd`, `result_json` for the tool response, and `event` for the
 * lifecycle event name. Cursor also has a shell-only payload shape
 * (`{command, output}` without `tool_name`) that must be normalized
 * to a `Bash` event.
 *
 * See claude-mem `src/cli/adapters/cursor.ts:30-53`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
import type { EventType } from "../core/types.js";
import { isObject, pickString } from "./util.js";
import { AdapterRejectedInput, isValidCwd } from "./errors.js";

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Derive the on-disk path to a Cursor agent transcript JSONL. Cursor
 *  stores transcripts at:
 *    ~/.cursor/projects/<workspace-slug>/agent-transcripts/<UUID>/<UUID>.jsonl
 *  where <workspace-slug> is the absolute cwd with the leading slash
 *  stripped and any '/' or '.' replaced with '-'. */
export function deriveCursorTranscriptPath(cwd: string, sessionId: string): string | undefined {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return undefined;
  const slug = cwd.replace(/^\//, "").replace(/[/.]/g, "-");
  const candidate = join(homedir(), ".cursor", "projects", slug, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
  return existsSync(candidate) ? candidate : undefined;
}

export class CursorAdapter implements PlatformAdapter {
  readonly name = "cursor" as const;

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    // Shell-only payload: Cursor's shell hook sends {command, output} without
    // a tool_name — synthesize a Bash event so file extraction can run.
    const isShellCommand = !!r["command"] && !r["tool_name"] && !r["toolName"];

    const session_id = pickString(r, ["conversation_id", "session_id", "generation_id", "id"]);
    if (!session_id) return null;

    const timestamp = typeof r["timestamp"] === "number"
      ? (r["timestamp"] as number)
      : Date.now();

    // workspace_roots[0] is the canonical cwd in Cursor; fall back to cwd.
    let cwd: string | null = null;
    if (Array.isArray(r["workspace_roots"]) && r["workspace_roots"]!.length > 0) {
      const first = r["workspace_roots"]![0];
      if (typeof first === "string" && first.length > 0) cwd = first;
    }
    if (!cwd) cwd = pickString(r, ["cwd"]);
    if (!cwd) cwd = process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput("invalid_cwd");
    }

    const tool_name = isShellCommand
      ? "Bash"
      : pickString(r, ["tool_name", "toolName"]);
    const tool_input = isShellCommand
      ? { command: r["command"] }
      : (r["tool_input"] ?? r["toolInput"] ?? r["args"] ?? null);
    const tool_output = isShellCommand
      ? { output: r["output"] }
      : (r["result_json"] ?? r["tool_response"] ?? r["tool_output"] ?? r["result"] ?? null);

    let event_type: EventType;
    let user_prompt: string | null = null;
    let final_response: string | null = null;

    if (r["event"] === "beforeSubmitPrompt" || r["prompt"] !== undefined) {
      event_type = "user_prompt";
      user_prompt = pickString(r, ["prompt"]);
    } else if (r["event"] === "stop" || r["last_assistant_message"] !== undefined) {
      event_type = "assistant_message";
      final_response = pickString(r, ["last_assistant_message"]);
    } else if (r["event"] === "sessionStart") {
      event_type = "session_init";
    } else if (r["event"] === "sessionEnd") {
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
    return { continue: result.continue ?? true };
  }
}
