/**
 * Hook protocol types — shared between the runner, the event handlers,
 * and the CLI. These mirror claude-mem's `src/cli/types.ts` but are
 * trimmed to what Termyte actually needs.
 */

import type { HookResult, NormalizedEvent } from "../capture/adapter.js";

/** What a handler receives: a normalized event plus the original raw
 *  payload (for handlers that need fields we don't normalize). */
export interface HandlerInput {
  event: NormalizedEvent;
  /** The original raw payload from stdin, or null if not available. */
  raw: unknown | null;
}

/** What a handler returns. The `output` is what the agent will see. */
export interface HandlerOutput {
  /** True if the handler took action; false = pass through. */
  handled: boolean;
  result: HookResult;
}

export type EventHandlerName =
  | "context"
  | "session-init"
  | "observation"
  | "summarize"
  | "file-edit"
  | "file-context";

export type EventHandler = (input: HandlerInput) => Promise<HandlerOutput>;
