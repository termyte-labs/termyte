/**
 * Adapter dispatch. The CLI uses `resolveAdapter` to pick the right
 * AgentAdapter for the user's environment, with a configurable
 * override. A `FakeAdapter` is always available for tests.
 */
import type { AgentAdapter, AgentAdapterId } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexAdapter } from "./codex.js";
import { FakeAdapter } from "./fake.js";

export { FakeAdapter };
export type { AgentAdapter, AgentAdapterId, AgentInvokeOptions, AgentInvokeResult, AgentInvocationError } from "./types.js";

// Re-export the concrete adapters so consumers can import them
// from one place. Keep the class names stable; tests pin them.
export { ClaudeCodeAdapter } from "./claude-code.js";
export { CodexAdapter } from "./codex.js";

/** Create a fresh adapter for the given id. The caller owns the
 *  instance and is responsible for any teardown (none required today). */
export function createAdapter(id: AgentAdapterId): AgentAdapter {
  switch (id) {
    case "claude-code": return new ClaudeCodeAdapter();
    case "codex":       return new CodexAdapter();
    case "fake":        return new FakeAdapter();
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown adapter id: ${exhaustive as string}`);
    }
  }
}

/** Discover which synthesis-capable agent the user has installed.
 *  Probes in priority order; first hit wins. */
export async function discoverAdapter(): Promise<AgentAdapterId | null> {
  for (const id of ["claude-code", "codex"] as const) {
    const a = createAdapter(id);
    if (await a.isAvailable()) return id;
  }
  return null;
}
