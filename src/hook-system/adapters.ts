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
      prompt: raw.prompt ?? raw.input,
      toolName: raw.toolName ?? raw.tool_name,
      toolInput: raw.toolInput ?? raw.tool_input,
      toolResponse: raw.toolResponse ?? raw.tool_response,
      model: raw.model,
    };
  }

  formatOutput(result: any): unknown {
    return result;
  }
}

// --- Registry ---

const adapters: Record<string, PlatformAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  "codex": new CodexAdapter(),
  "cursor": new CursorAdapter(),
  "windsurf": new WindsurfAdapter(),
  "gemini-cli": new GeminiCliAdapter(),
  "raw": new RawAdapter(),
};

export function getAdapter(platform: string): PlatformAdapter {
  const normalized = platform.toLowerCase().replace(/[_\s]/g, "-");
  return adapters[normalized] ?? adapters["raw"];
}

export function detectPlatform(raw: any): PlatformSource {
  if (raw.platform) return raw.platform as PlatformSource;
  if (raw.agentType === "claude-code" || raw.agent_id?.startsWith("claude")) return "claude-code";
  if (raw.agentType === "codex" || raw.agent_id?.startsWith("codex")) return "codex";
  return "termyte";
}
