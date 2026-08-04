import type { AgentClient } from "../llm/agent-client.js";
import type { Store } from "../storage/store.js";
import { readRepositoryState } from "../capture/git-state.js";
import type { Experience, SessionHandoff, Trace } from "../shared/types.js";
import { compactAll, fitText } from "./budget.js";
import { readRepositoryProfile } from "./repository-profile.js";

export interface ContextLimits {
  briefingTokens: number;
  promptTokens: number;
  catalogueTokens: number;
  selectionTimeoutMs: number;
}

const DEFAULT_LIMITS: ContextLimits = {
  briefingTokens: 3_000,
  promptTokens: 1_500,
  catalogueTokens: 4_000,
  selectionTimeoutMs: 5_000,
};

export class ContextBuilder {
  constructor(
    private readonly store: Store,
    private readonly agent?: AgentClient,
    private readonly limits: ContextLimits = DEFAULT_LIMITS,
  ) {}

  /** Legacy deterministic handoff retained for API compatibility. */
  async buildSessionHandoff(input: { repoId: string; sessionId: string; workspaceRoot: string }): Promise<SessionHandoff | null> {
    const previous = this.store.getPreviousSession(input.repoId, input.sessionId);
    if (!previous) return null;
    const existing = this.store.getHandoff(previous.session_id);
    if (existing) return existing;
    const traces = this.store.getTracesForSession(previous.session_id);
    if (traces.length === 0) return null;
    return this.store.saveHandoff({
      sourceSessionId: previous.session_id,
      targetSessionId: input.sessionId,
      repoId: input.repoId,
      content: buildLegacyHandoff(traces, readRepositoryState(input.workspaceRoot)),
    });
  }

  buildProjectBriefing(input: { repoId: string; sessionId: string; workspaceRoot: string }): string {
    const profile = readRepositoryProfile(input.workspaceRoot);
    const git = readRepositoryState(input.workspaceRoot);
    const sessions = this.store.getRecentSessions(input.repoId, input.sessionId, 8).map((session) => {
      const traces = this.store.getTracesForSession(session.session_id);
      const prompt = [...traces].reverse().find((trace) => trace.user_prompt)?.user_prompt;
      const result = [...traces].reverse().find((trace) => trace.final_response)?.final_response;
      const files = [...new Set(traces.flatMap((trace) => [...(trace.files_read ?? []), ...(trace.files_modified ?? [])]))].slice(0, 12);
      return `- ${session.session_id}: ${shorten(prompt ?? "No captured request", 300)}${result ? ` | Result: ${shorten(result, 300)}` : " | Unfinished"}${files.length ? ` | Files: ${files.join(", ")}` : ""}`;
    });
    const experiences = compactAll(this.store.listExperiences(input.repoId).map(catalogueLine), Math.max(256, Math.floor(this.limits.briefingTokens * 0.45)));
    const briefing = [
      "Termyte project briefing",
      profile ? `Repository\n${profile}` : null,
      `Current Git state\n${JSON.stringify(git, null, 2)}`,
      sessions.length ? `Recent and unfinished tasks\n${sessions.join("\n")}` : null,
      experiences.length ? `Project experience from earlier sessions\n${experiences.join("\n")}` : null,
    ].filter(Boolean).join("\n\n");
    return fitText(briefing, this.limits.briefingTokens);
  }

  async buildPromptContext(input: { repoId: string; sessionId: string; workspaceRoot: string; prompt: string; projectBriefing?: string }): Promise<string | null> {
    const experiences = this.store.listExperiences(input.repoId);
    if (experiences.length === 0) return null;
    const catalogue = compactAll(experiences.map(catalogueLine), this.limits.catalogueTokens).join("\n");
    let selectedIds: string[];
    if (this.agent) {
      try {
        const response = await this.agent.complete(selectionPrompt(input.prompt, input.projectBriefing ?? "", catalogue), {
          cwd: input.workspaceRoot,
          timeoutMs: this.limits.selectionTimeoutMs,
        });
        selectedIds = parseSelectedIds(response, new Set(experiences.map((item) => item.id)));
      } catch {
        selectedIds = localSelect(experiences, input.prompt);
      }
    } else {
      selectedIds = localSelect(experiences, input.prompt);
    }
    const selected = this.store.getExperiencesByIds(input.repoId, selectedIds.slice(0, 4));
    if (selected.length === 0) return null;
    const packet = selected.map((experience) => [
      `[${experience.id}] ${experience.content}`,
      experience.evidence ? `Supporting session evidence: ${shorten(experience.evidence, 2_000)}` : null,
    ].filter(Boolean).join("\n")).join("\n\n---\n\n");
    return fitText(`Termyte context relevant to this request\n\n${packet}`, this.limits.promptTokens);
  }

  recall(repoId: string, query: string): SessionHandoff[] {
    return this.store.searchHandoffs(repoId, query, 3);
  }
}

function selectionPrompt(request: string, briefing: string, catalogue: string): string {
  return `Select prior project experiences that would materially help a coding agent answer the current request.

Return JSON only: {"experience_ids":["id"]}. Return an empty array when nothing is relevant. Select at most 4. Prefer direct technical applicability, developer corrections, failed approaches, and recent evidence. Do not select an item just because it shares broad words.

Current request:
${shorten(request, 4_000)}

Project briefing:
${shorten(briefing, 4_000)}

Experience catalogue (covers all stored experiences in this repository):
${catalogue}`;
}

function parseSelectedIds(value: string, allowed: Set<string>): string[] {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as { experience_ids?: unknown };
  if (!Array.isArray(parsed.experience_ids)) throw new Error("agent did not return experience_ids");
  return [...new Set(parsed.experience_ids.filter((id): id is string => typeof id === "string" && allowed.has(id)))].slice(0, 4);
}

function localSelect(experiences: Experience[], query: string): string[] {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []);
  if (terms.size === 0) return [];
  return experiences.map((experience, index) => {
    const text = experience.content.toLowerCase();
    const score = [...terms].reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
    return { id: experience.id, score, index };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 4).map((item) => item.id);
}

function catalogueLine(experience: Experience): string {
  return `[${experience.id}] ${experience.content.replace(/\s+/g, " ").trim()}`;
}

function buildLegacyHandoff(traces: Trace[], git: unknown): string {
  const prompt = [...traces].reverse().find((trace) => trace.user_prompt)?.user_prompt;
  const result = [...traces].reverse().find((trace) => trace.final_response)?.final_response;
  const actions = traces.filter((trace) => trace.event_type === "tool_use").slice(-4).map((trace) => `${trace.tool_name ?? "tool"}: ${shorten(render(trace.tool_input ?? trace.tool_output ?? "used"), 1_500)}`);
  return [prompt ? `Previous request:\n${prompt}` : null, result ? `Previous agent result:\n${result}` : null, actions.length ? `Recent concrete actions:\n${actions.join("\n")}` : null, `Current repository state:\n${JSON.stringify(git, null, 2)}`].filter(Boolean).join("\n\n");
}

function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
