import type { NormalizedHookInput, PlatformAdapter, PlatformSource } from "../types.js";

// Claude Code adapter
class ClaudeCodeAdapter implements PlatformAdapter {
  normalizeInput(raw: any): NormalizedHookInput {
    return {
      sessionId: raw.sessionId ?? raw.session_id ?? raw.session?.id ?? "unknown",
      cwd: raw.cwd ?? raw.working_directory ?? process.cwd(),
      platform: "claude-code",
      prompt: raw.prompt ?? raw.user_prompt ?? raw.input,
      toolName: raw.toolName ?? raw.tool_name,
      toolInput: raw.toolInput ?? raw.tool_input,
      toolResponse: raw.toolResponse ?? raw.tool_response,
      transcriptPath: raw.transcriptPath ?? raw.transcript_path,
      lastAssistantMessage: raw.lastAssistantMessage ?? raw.last_assistant_message,
      turnId: raw.turnId ?? raw.turn_id,
      stopHookActive: raw.stopHookActive ?? raw.stop_hook_active,
      permissionMode: raw.permissionMode ?? raw.permission_mode,
      model: raw.model,
      sessionSource: raw.sessionSource ?? raw.session_source,
      filePath: raw.filePath ?? raw.file_path,
      edits: raw.edits,
      agentId: raw.agentId ?? raw.agent_id,
      agentType: raw.agentType ?? raw.agent_type,
    };
  }

  formatOutput(result: any): unknown {
    return result;
  }
}

// Codex adapter
class CodexAdapter implements PlatformAdapter {
  normalizeInput(raw: any): NormalizedHookInput {
    return {
      sessionId: raw.session_id ?? raw.sessionId ?? raw.session?.id ?? "unknown",
      cwd: raw.cwd ?? raw.working_directory ?? process.cwd(),
      platform: "codex",
      prompt: raw.prompt ?? raw.user_prompt,
      toolName: raw.toolName ?? raw.tool_name,
      toolInput: raw.toolInput ?? raw.tool_input,
      toolResponse: raw.toolResponse ?? raw.tool_response,
      lastAssistantMessage: raw.lastAssistantMessage,
      model: raw.model,
      agentId: raw.agentId,
      agentType: raw.agentType,
    };
  }

  formatOutput(result: any): unknown {
    return result;
  }
}

// Cursor adapter
class CursorAdapter implements PlatformAdapter {
  normalizeInput(raw: any): NormalizedHookInput {
    return {
      sessionId: raw.sessionId ?? raw.session_id ?? "unknown",
      cwd: raw.cwd ?? raw.working_directory ?? process.cwd(),
      platform: "cursor",
      prompt: raw.prompt ?? raw.input,
      toolName: raw.toolName,
      toolInput: raw.toolInput,
      toolResponse: raw.toolResponse,
      model: raw.model,
    };
  }

  formatOutput(result: any): unknown {
    return result;
  }
}

// Windsurf adapter
class WindsurfAdapter implements PlatformAdapter {
  normalizeInput(raw: any): NormalizedHookInput {
    return {
      sessionId: raw.sessionId ?? raw.session_id ?? "unknown",
      cwd: raw.cwd ?? raw.working_directory ?? process.cwd(),
      platform: "windsurf",
      prompt: raw.prompt ?? raw.input,
      toolName: raw.toolName,
      toolInput: raw.toolInput,
      toolResponse: raw.toolResponse,
      model: raw.model,
    };
  }

  formatOutput(result: any): unknown {
    return result;
  }
}

// Gemini CLI adapter
class GeminiCliAdapter implements PlatformAdapter {
  normalizeInput(raw: any): NormalizedHookInput {
    return {
      sessionId: raw.sessionId ?? raw.session_id ?? "unknown",
      cwd: raw.cwd ?? raw.working_directory ?? process.cwd(),
      platform: "gemini-cli",
      prompt: raw.prompt ?? raw.input,
      toolName: raw.toolName,
      toolInput: raw.toolInput,
      toolResponse: raw.toolResponse,
      model: raw.model,
    };
  }

  formatOutput(result: any): unknown {
    return result;
  }
}

// Raw adapter (generic, for any unrecognized platform)
class RawAdapter implements PlatformAdapter {
  normalizeInput(raw: any): NormalizedHookInput {
    return {
      sessionId: raw.sessionId ?? raw.session_id ?? "unknown",
      cwd: raw.cwd ?? raw.working_directory ?? process.cwd(),
      platform: raw.platform ?? "raw",
      hookEvent: raw.hookEvent ?? raw.hook_event,
      prompt: raw.prompt ?? raw.input ?? raw.user_prompt,
      toolName: raw.toolName ?? raw.tool_name,
      toolInput: raw.toolInput ?? raw.tool_input ?? raw.tool_args,
      toolResponse: raw.toolResponse ?? raw.tool_response ?? raw.tool_result,
      lastAssistantMessage: raw.lastAssistantMessage ?? raw.last_assistant_message ?? raw.assistant_text,
      model: raw.model,
      turnId: raw.turnId ?? raw.turn_id ?? raw.messageID ?? raw.message_id,
      agentId: raw.agentId ?? raw.agent_id,
      agentType: raw.agentType ?? raw.agent_type ?? raw.platform,
      sessionSource: raw.sessionSource ?? raw.session_source,
      filePath: raw.filePath ?? raw.file_path,
      command: raw.command,
      commandExitCode: raw.commandExitCode ?? raw.command_exit_code ?? raw.exitCode ?? raw.exit_code,
      rawEvent: raw.event ?? raw.rawEvent ?? raw.raw_event,
    };
  }

  formatOutput(result: any): unknown {
    return result;
  }
}

// OpenCode adapter - receives payloads from the termyte OpenCode plugin
// which translates OpenCode's event stream into our canonical format.
export class OpenCodeAdapter implements PlatformAdapter {
  normalizeInput(raw: any): NormalizedHookInput {
    const sessionId = raw.sessionId ?? raw.session_id ?? raw.sessionID ?? "unknown";
    const cwd = raw.cwd ?? raw.directory ?? raw.worktree ?? process.cwd();
    const rawEvent: string | undefined = raw.event ?? raw.rawEvent;

    let hookEvent = raw.hookEvent ?? raw.hook_event;
    if (!hookEvent && rawEvent && rawEvent !== "message.part.updated" && rawEvent !== "message.updated") {
      hookEvent = mapOpenCodeEventToHookEvent(rawEvent);
    }

    let toolName = raw.toolName ?? raw.tool_name;
    let toolInput = raw.toolInput ?? raw.tool_input ?? raw.tool_args;
    let toolResponse = raw.toolResponse ?? raw.tool_response ?? raw.tool_result;
    let prompt = raw.prompt ?? raw.user_prompt ?? raw.userPrompt;
    let lastAssistantMessage = raw.lastAssistantMessage ?? raw.last_assistant_message ?? raw.assistant_text ?? raw.assistantText;
    let command = raw.command;
    let commandExitCode = raw.commandExitCode ?? raw.command_exit_code ?? raw.exitCode;
    let filePath = raw.filePath ?? raw.file_path;

    // Translate OpenCode-specific shapes. Part-based events (message.part.updated)
    // get re-mapped here because the part type disambiguates the event.
    const part = raw.part;
    if (part && typeof part === "object") {
      if (part.type === "tool" || part.type === "tool_use") {
        hookEvent = "tool_use";
        toolName = toolName ?? part.tool ?? part.name;
        toolInput = toolInput ?? part.input ?? part.args;
        toolResponse = toolResponse ?? part.result ?? part.output;
        command = command ?? (toolInput as any)?.command;
      } else if (part.type === "text") {
        if (part.role === "assistant" || raw.role === "assistant") {
          hookEvent = "assistant_message";
          lastAssistantMessage = lastAssistantMessage ?? part.text;
        } else {
          hookEvent = "user_prompt";
          prompt = prompt ?? part.text;
        }
      }
    }

    // If we still have no hookEvent, fall back to the event-name mapping
    if (!hookEvent && rawEvent) {
      hookEvent = mapOpenCodeEventToHookEvent(rawEvent);
    }

    // tool.execute.before/after carry { input: { tool, args }, output: { args } }
    if (rawEvent === "tool.execute.before" || rawEvent === "tool.execute.after") {
      hookEvent = "tool_use";
      const evInput = raw.input ?? {};
      const evOutput = raw.output ?? {};
      toolName = toolName ?? evInput.tool ?? evOutput.tool;
      toolInput = toolInput ?? evOutput.args ?? evInput.args;
      toolResponse = toolResponse ?? evOutput.result ?? evInput.result;
      command = command ?? (toolInput as any)?.command;
      commandExitCode = commandExitCode ?? evOutput.exitCode ?? evInput.exitCode;
    }

    // file.edited { filePath, content }
    if (rawEvent === "file.edited" && hookEvent === undefined) {
      hookEvent = "file_edit";
      filePath = filePath ?? raw.filePath ?? raw.file_path;
    }

    // command.executed { command, exitCode }
    if (rawEvent === "command.executed" && hookEvent === undefined) {
      hookEvent = "command";
      command = command ?? raw.command;
      commandExitCode = commandExitCode ?? raw.exitCode;
    }

    return {
      sessionId,
      cwd,
      platform: "opencode",
      hookEvent,
      prompt,
      toolName,
      toolInput,
      toolResponse,
      lastAssistantMessage,
      command,
      commandExitCode,
      filePath,
      model: raw.model,
      turnId: raw.turnId ?? raw.turn_id ?? raw.messageID ?? raw.message_id,
      agentId: raw.agentId ?? raw.agent_id,
      agentType: "opencode",
      sessionSource: raw.sessionSource ?? raw.session_source ?? (rawEvent === "session.created" ? "startup" : undefined),
      rawEvent,
    };
  }

  formatOutput(result: any): unknown {
    return result;
  }
}

function mapOpenCodeEventToHookEvent(event: string): import("../types.js").HookEventName {
  switch (event) {
    case "session.created":
    case "session.resumed":
      return "session_start";
    case "session.idle":
    case "session.deleted":
    case "session.compacted":
    case "session.error":
      return "session_end";
    case "tool.execute.before":
    case "tool.execute.after":
      return "tool_use";
    case "file.edited":
      return "file_edit";
    case "command.executed":
      return "command";
    case "message.part.updated":
    case "message.updated":
      return "assistant_message";
    case "permission.asked":
    case "permission.replied":
      return "user_prompt";
    default:
      return "unknown";
  }
}

// --- Registry ---

const adapters: Record<string, PlatformAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  "codex": new CodexAdapter(),
  "cursor": new CursorAdapter(),
  "windsurf": new WindsurfAdapter(),
  "gemini-cli": new GeminiCliAdapter(),
  "opencode": new OpenCodeAdapter(),
  "raw": new RawAdapter(),
};

export function getAdapter(platform: string): PlatformAdapter {
  const normalized = platform.toLowerCase().replace(/[_\s]/g, "-");
  return adapters[normalized] ?? adapters["raw"];
}

export function detectPlatform(raw: any): PlatformSource {
  if (raw.platform) return raw.platform as PlatformSource;
  if (raw.event && typeof raw.event === "string" && raw.event.startsWith("session.")) return "opencode";
  if (raw.event && typeof raw.event === "string" && (raw.event.startsWith("tool.") || raw.event.startsWith("message.") || raw.event.startsWith("command."))) return "opencode";
  if (raw.sessionID) return "opencode";
  if (raw.agentType === "claude-code" || raw.agent_id?.startsWith("claude")) return "claude-code";
  if (raw.agentType === "codex" || raw.agent_id?.startsWith("codex")) return "codex";
  return "termyte";
}
