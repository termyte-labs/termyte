import type { Store } from "../storage/store.js";
import { readRepositoryState } from "../capture/git-state.js";
import type { SessionHandoff, Trace } from "../shared/types.js";

export class ContextBuilder {
  constructor(private readonly store: Store) {}

  async buildSessionHandoff(input: { repoId: string; sessionId: string; workspaceRoot: string }): Promise<SessionHandoff | null> {
    const previous = this.store.getPreviousSession(input.repoId, input.sessionId);
    if (!previous) return null;
    const existing = this.store.getHandoff(previous.session_id);
    if (existing) return existing;

    const traces = this.store.getTracesForSession(previous.session_id);
    if (traces.length === 0) return null;
    const content = buildHandoff(traces, readRepositoryState(input.workspaceRoot));
    return this.store.saveHandoff({
      sourceSessionId: previous.session_id,
      targetSessionId: input.sessionId,
      repoId: input.repoId,
      content,
    });
  }

  recall(repoId: string, query: string): SessionHandoff[] {
    return this.store.searchHandoffs(repoId, query, 3);
  }
}

function buildHandoff(traces: Trace[], git: unknown): string {
  const prompt = [...traces].reverse().find((trace) => trace.user_prompt)?.user_prompt;
  const result = [...traces].reverse().find((trace) => trace.final_response)?.final_response;
  const actions = traces
    .filter((trace) => trace.event_type === "tool_use")
    .slice(-4)
    .map((trace) => `${trace.tool_name ?? "tool"}: ${shorten(render(trace.tool_input ?? trace.tool_output ?? "used"))}`);
  return [
    prompt ? `Previous request:\n${prompt}` : null,
    result ? `Previous agent result:\n${result}` : null,
    actions.length ? `Recent concrete actions:\n${actions.join("\n")}` : null,
    `Current repository state:\n${JSON.stringify(git, null, 2)}`,
  ].filter(Boolean).join("\n\n");
}

function shorten(value: string): string {
  return value.length <= 1_500 ? value : `${value.slice(0, 1_500)}...`;
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
