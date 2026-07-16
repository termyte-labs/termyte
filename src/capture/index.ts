export type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
export type { Platform } from "../core/types.js";
export { AdapterRejectedInput, isValidCwd } from "./errors.js";
export { ClaudeCodeAdapter } from "./claude-code.js";
export { CodexAdapter } from "./codex.js";
export { RawAdapter } from "./raw.js";
export { Ingestor } from "./ingest.js";
export { extractFilesFromEvent, type ExtractedFiles } from "./files.js";
export { extractCodexFilePaths } from "./codex-file-context.js";

import type { Platform } from "../core/types.js";
import type { PlatformAdapter } from "./adapter.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { RawAdapter } from "./raw.js";

/** Build the adapter for a given platform name. Unknown platforms fall
 *  through to the RawAdapter so a misconfigured hook still produces a
 *  trace instead of crashing the agent. */
export function adapterFor(platform: Platform): PlatformAdapter {
  switch (platform) {
    case "claude-code": return new ClaudeCodeAdapter();
    case "codex":       return new CodexAdapter();
    case "raw":         return new RawAdapter();
    default: {
      const exhaustive: never = platform;
      throw new Error(`unknown platform: ${exhaustive as string}`);
    }
  }
}
