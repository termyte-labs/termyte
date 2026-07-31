export type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
export type { Platform } from "../shared/types.js";
export { AdapterRejectedInput, isValidCwd } from "./errors.js";
export { ClaudeCodeAdapter } from "../agents/adapters/claude-code.js";
export { CodexAdapter } from "../agents/adapters/codex.js";
export { OpenCodeAdapter } from "../agents/adapters/opencode.js";
export { RawAdapter } from "../agents/adapters/raw.js";
export { Ingestor } from "./ingest.js";
export { extractFilesFromEvent, type ExtractedFiles } from "./files.js";
export { extractCodexFilePaths } from "../agents/adapters/codex-file-context.js";

import type { Platform } from "../shared/types.js";
import type { PlatformAdapter } from "./adapter.js";
import { ClaudeCodeAdapter } from "../agents/adapters/claude-code.js";
import { CodexAdapter } from "../agents/adapters/codex.js";
import { OpenCodeAdapter } from "../agents/adapters/opencode.js";
import { RawAdapter } from "../agents/adapters/raw.js";

/** Build the adapter for a given platform name. Unknown platforms fall
 *  through to the RawAdapter so a misconfigured hook still produces a
 *  trace instead of crashing the agent. */
export function adapterFor(platform: Platform): PlatformAdapter {
  switch (platform) {
    case "claude-code": return new ClaudeCodeAdapter();
    case "codex":       return new CodexAdapter();
    case "opencode":    return new OpenCodeAdapter();
    case "raw":         return new RawAdapter();
    default: {
      const exhaustive: never = platform;
      throw new Error(`unknown platform: ${exhaustive as string}`);
    }
  }
}
