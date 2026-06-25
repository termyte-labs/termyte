export type { PlatformAdapter, NormalizedEvent } from "./adapter.js";
export type { Platform } from "../core/types.js";
export { ClaudeCodeAdapter } from "./claude-code.js";
export { CodexAdapter } from "./codex.js";
export { OpenCodeAdapter } from "./opencode.js";
export { CursorAdapter } from "./cursor.js";
export { Ingestor } from "./ingest.js";
export { extractFilesFromEvent, type ExtractedFiles } from "./files.js";

import type { Platform } from "../core/types.js";
import type { PlatformAdapter } from "./adapter.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { OpenCodeAdapter } from "./opencode.js";
import { CursorAdapter } from "./cursor.js";

/** Build the adapter for a given platform name. */
export function adapterFor(platform: Platform): PlatformAdapter {
  switch (platform) {
    case "claude-code":
      return new ClaudeCodeAdapter();
    case "codex":
      return new CodexAdapter();
    case "opencode":
      return new OpenCodeAdapter();
    case "cursor":
      return new CursorAdapter();
    default: {
      const exhaustive: never = platform;
      throw new Error(`unknown platform: ${exhaustive as string}`);
    }
  }
}
