import type { NormalizedHookInput, HookResult } from "../types.js";
import { getAdapter } from "./adapters.js";
import { readStdin, writeJson, buildHookResult, runWithTimeout, HOOK_TIMEOUTS } from "./hook-io.js";
import { createLogger } from "./logger.js";

export interface HookCommandOptions {
  verbose?: boolean;
  adapter?: string;
  handler: (input: NormalizedHookInput) => Promise<HookResult>;
}

export async function hookCommand(options: HookCommandOptions): Promise<void> {
  const logger = createLogger(options.verbose);

  try {
    const rawInput = await readStdin();

    if (!rawInput || typeof rawInput !== "object") {
      writeJson(buildHookResult({ hookEventName: "termyte", additionalContext: "" }));
      process.exit(0);
    }

    const platform = options.adapter ?? (rawInput as any).platform ?? "raw";
    const adapter = getAdapter(platform);
    const normalizedInput = adapter.normalizeInput(rawInput);

    const event = detectHookEvent(normalizedInput);

    const result = await runWithTimeout(
      `hook:${event}`,
      () => options.handler(normalizedInput),
      HOOK_TIMEOUTS.session,
      logger,
    );

    if (!result.ok) {
      writeJson(buildHookResult({ hookEventName: event, additionalContext: "" }));
      process.exit(0);
    }

    writeJson(result.result);
  } catch (error) {
    logger.error("hook command failed", error as Error);
    writeJson(buildHookResult({ hookEventName: "termyte", additionalContext: "" }));
    process.exit(0);
  }
}

function detectHookEvent(input: NormalizedHookInput): string {
  if (input.sessionSource === "startup" || input.sessionSource === "resume") {
    return "session_start";
  }
  if (input.toolName) {
    return "tool_use";
  }
  if (input.prompt) {
    return "user_prompt";
  }
  return "unknown";
}

function detectPlatform(raw: any): string {
  if (raw.platform) return raw.platform;
  if (raw.agentType === "claude-code" || raw.agent_id?.startsWith("claude")) return "claude-code";
  if (raw.agentType === "codex" || raw.agent_id?.startsWith("codex")) return "codex";
  return "raw";
}
