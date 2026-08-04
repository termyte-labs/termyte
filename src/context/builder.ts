import type { AgentClient } from "../llm/agent-client.js";
import type { Store } from "../storage/store.js";
import { readRepositoryState, type RepositoryState } from "../capture/git-state.js";
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
  briefingTokens: 800,
  promptTokens: 300,
  catalogueTokens: 4_000,
  selectionTimeoutMs: 5_000,
};

const MAX_PROMPT_WORDS = 250;

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
    const sessions = this.store.getRecentSessions(input.repoId, input.sessionId, 6).map((session) => {
      const traces = this.store.getTracesForSession(session.session_id);
      const prompt = [...traces].reverse().find((trace) => trace.user_prompt)?.user_prompt;
      const result = [...traces].reverse().find((trace) => trace.final_response)?.final_response;
      const files = [...new Set(traces.flatMap((trace) => [...(trace.files_read ?? []), ...(trace.files_modified ?? [])]))].slice(0, 8);
      return `- Task: ${shorten(prompt ?? "No captured request", 220)} | State: ${result ? "completed response captured" : "unfinished"}${files.length ? ` | Files: ${files.join(", ")}` : ""}`;
    });
    const experiences = compactAll(this.store.listExperiences(input.repoId).map(experienceCatalogueLine), Math.max(256, Math.floor(this.limits.briefingTokens * 0.4)));
    const briefing = [
      "## Termyte project context",
      profile ? `Repository\n${profile}` : null,
      `Current Git state\n${formatGitState(git)}`,
      sessions.length ? `Recent work\n${sessions.join("\n")}` : null,
      experiences.length ? `Relevant project lessons\n${experiences.join("\n")}` : null,
    ].filter(Boolean).join("\n\n");
    return fitText(briefing, this.limits.briefingTokens);
  }

  async buildPromptContext(input: { repoId: string; sessionId: string; workspaceRoot: string; prompt: string; projectBriefing?: string }): Promise<string | null> {
    const experiences = this.store.listExperiences(input.repoId);
    if (experiences.length === 0) return null;
    const catalogue = compactAll(experiences.map(experienceCatalogueLine), this.limits.catalogueTokens).join("\n");
    let edit: ContextEdit | null = null;
    let editorResponded = false;
    if (this.agent) {
      try {
        const response = await this.agent.complete(contextEditorPrompt(input.prompt, input.projectBriefing ?? "", catalogue), {
          cwd: input.workspaceRoot,
          timeoutMs: this.limits.selectionTimeoutMs,
        });
        edit = parseContextEdit(response, new Set(experiences.map((item) => item.id)));
        editorResponded = true;
      } catch {
        edit = null;
      }
    }
    if (editorResponded && !edit?.useful) return null;
    if (edit?.useful) {
      const selected = this.store.getExperiencesByIds(input.repoId, edit.experience_ids);
      if (selected.length > 0) return renderEditedContext(edit.context, selected, this.limits.promptTokens);
    }
    return renderLocalContext(localSelect(experiences, input.prompt), experiences, this.limits.promptTokens);
  }

  recall(repoId: string, query: string): SessionHandoff[] {
    return this.store.searchHandoffs(repoId, query, 3);
  }
}

interface ContextEdit {
  useful: boolean;
  experience_ids: string[];
  context: string;
}

function contextEditorPrompt(request: string, briefing: string, catalogue: string): string {
  return `You are Termyte's context editor. Decide whether prior project experience would materially change how the coding agent handles the current request, then write only the useful context.

Return JSON only with this shape: {"useful":true,"experience_ids":["id"],"context":"markdown"}.
Return {"useful":false,"experience_ids":[],"context":""} when history does not materially help.

Rules for context:
- Return only information that could change how the agent handles the current request.
  - Keep the context concise and below 250 words.
- Remove raw prompts, tool payloads, patches, duplicated statements, and historical details that do not affect the task.
- Never include supporting evidence JSON. Termyte adds compact evidence references separately.
- Never convert an implementation action into a developer preference or correction.
- Describe unverified information as unverified.
- Do not suggest committing, pushing, merging, deleting, or other repository actions merely because an old session mentioned them.

Current request:
${shorten(request, 3_000)}

Project briefing:
${shorten(briefing, 3_000)}

Experience catalogue:
${catalogue}`;
}

function parseContextEdit(value: string, allowed: Set<string>): ContextEdit {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "context,experience_ids,useful") throw new Error("context editor returned an unexpected JSON shape");
  const useful = parsed.useful === true;
  const ids = Array.isArray(parsed.experience_ids)
    ? [...new Set(parsed.experience_ids.filter((id): id is string => typeof id === "string" && allowed.has(id)))].slice(0, 4)
    : [];
  const context = typeof parsed.context === "string" ? sanitizeEditedContext(parsed.context) : "";
  return { useful: useful && ids.length > 0 && context.length > 0, experience_ids: ids, context };
}

function renderEditedContext(context: string, selected: Experience[], tokenLimit: number): string | null {
  const clean = sanitizeEditedContext(context);
  if (!clean) return null;
  const refs = selected.map(evidenceReference).filter(Boolean);
  return fitPromptContext(["## Termyte project context", clean, refs.length ? refs.join("\n") : null].filter(Boolean).join("\n\n"), tokenLimit);
}

function renderLocalContext(ids: string[], experiences: Experience[], tokenLimit: number): string | null {
  const selected = ids.flatMap((id) => experiences.find((experience) => experience.id === id) ?? []);
  if (selected.length === 0) return null;
  const summaries = selected.map((experience) => `${summarizeExperience(experience)}\n${evidenceReference(experience)}`).join("\n\n");
  return fitPromptContext(`## Termyte project context\n${summaries}`, tokenLimit);
}

function fitPromptContext(value: string, tokenLimit: number): string {
  const byConfiguredLimit = fitText(value, tokenLimit);
  const words = byConfiguredLimit.match(/\S+/g) ?? [];
  return words.length <= MAX_PROMPT_WORDS ? byConfiguredLimit : words.slice(0, MAX_PROMPT_WORDS).join(" ");
}

function localSelect(experiences: Experience[], query: string): string[] {
  const stopWords = new Set(["this", "that", "with", "from", "into", "what", "when", "where", "will", "have", "should", "please", "make", "does", "need", "code", "file", "test"]);
  const terms = new Set((query.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? []).filter((term) => !stopWords.has(term)));
  if (terms.size === 0) return [];
  return experiences.map((experience, index) => {
    const text = experience.content.toLowerCase();
    const score = [...terms].reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
    return { id: experience.id, score, index };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3).map((item) => item.id);
}

function experienceCatalogueLine(experience: Experience): string {
  return `[${experience.id}] ${summarizeExperience(experience)}`;
}

function summarizeExperience(experience: Experience): string {
  const sections = experience.content.split(/\n\n+/);
  const useful = sections.filter((section) => {
    const heading = section.trim();
    return !/^(?:Developer corrections|Explicit developer corrections|Unfinished or uncertain):/i.test(heading);
  });
  return shorten(useful.join(" ").replace(/\s+/g, " ").trim(), 650);
}

function evidenceReference(experience: Experience): string {
  const ids = traceIds(experience.evidence);
  return ids.length ? `Evidence: session ${experience.source_session_id}, traces ${ids.join(", ")}` : `Evidence: session ${experience.source_session_id}`;
}

function traceIds(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    const ids = new Set<number>();
    collectTraceIds(parsed, ids);
    return [...ids].sort((a, b) => a - b).slice(0, 12);
  } catch { return []; }
}

function collectTraceIds(value: unknown, ids: Set<number>): void {
  if (Array.isArray(value)) { for (const item of value) collectTraceIds(item, ids); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "trace_id" && typeof item === "number") ids.add(item);
    else if (key === "trace_ids" && Array.isArray(item)) item.filter((id): id is number => typeof id === "number").forEach((id) => ids.add(id));
    else collectTraceIds(item, ids);
  }
}

function sanitizeEditedContext(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*Supporting session evidence:[\s\S]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatGitState(git: RepositoryState | null): string {
  if (!git) return "Unavailable";
  const changed = git.changedPaths.slice(0, 10);
  const parts = [git.branch ? `branch ${git.branch}` : null, git.head ? `commit ${git.head.slice(0, 8)}` : null, changed.length ? `changed ${changed.join(", ")}` : "clean working tree", git.conflicts.length ? `conflicts ${git.conflicts.join(", ")}` : null].filter(Boolean);
  return parts.join("; ");
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
