export type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
export type { Platform } from "../shared/types.js";
export { AdapterRejectedInput, isValidCwd } from "./errors.js";
export { Ingestor } from "./ingest.js";
export { extractFilesFromEvent, type ExtractedFiles } from "./files.js";

import type { Platform } from "../shared/types.js";
import type { PlatformAdapter } from "./adapter.js";
import { ClaudeCodeAdapter } from "../agents/adapters/claude-code.js";
import { CodexAdapter } from "../agents/adapters/codex.js";

export function adapterFor(platform: Platform): PlatformAdapter {
  return platform === "claude-code" ? new ClaudeCodeAdapter() : new CodexAdapter();
}
