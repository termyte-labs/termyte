import { createHash } from "node:crypto";
import type { AgentClient } from "../llm/agent-client.js";
import type { Store } from "../storage/store.js";
import type { Experience, Trace } from "../shared/types.js";

interface ReflectionOutput {
  lesson: string;
  worked: string[];
  failed: string[];
  corrections: string[];
  patterns: string[];
  unfinished: string[];
}

export class ReflectionService {
  constructor(private readonly store: Store, private readonly agent: AgentClient) {}

  isMeaningfulSession(sessionId: string): boolean {
    const traces = this.store.getTracesForSession(sessionId);
    return traces.some((trace) => trace.user_prompt) && traces.some((trace) => trace.event_type === "tool_use" || trace.final_response);
  }

  async reflect(repositoryId: string, sessionId: string, workspaceRoot?: string): Promise<Experience> {
    const existing = this.store.getExperienceForSession(sessionId);
    if (existing) return existing;
    const traces = this.store.getTracesForSession(sessionId);
    if (!isMeaningful(traces)) throw new Error("session is not meaningful enough to reflect");
    const evidence = buildEvidence(traces);
    const response = await this.agent.complete(reflectionPrompt(evidence), { cwd: workspaceRoot, timeoutMs: 60_000 });
    const parsed = parseReflection(response);
    const content = renderExperience(parsed);
    const id = `exp_${createHash("sha256").update(`${repositoryId}\0${sessionId}`).digest("hex").slice(0, 24)}`;
    return this.store.saveExperience({
      id,
      repository_id: repositoryId,
      source_session_id: sessionId,
      content,
      evidence: JSON.stringify(evidence),
    });
  }
}

function isMeaningful(traces: Trace[]): boolean {
  return traces.some((trace) => trace.user_prompt) && traces.some((trace) => trace.event_type === "tool_use" || trace.final_response);
}

function buildEvidence(traces: Trace[]): Record<string, unknown> {
  const prompts = traces.filter((trace) => trace.user_prompt).slice(-8).map((trace) => ({ trace_id: trace.id, text: shorten(trace.user_prompt!, 2_000) }));
  const actions = traces.filter((trace) => trace.event_type === "tool_use").slice(-12).map((trace) => ({
    trace_id: trace.id,
    tool: trace.tool_name,
    input: shorten(render(trace.tool_input), 1_000),
    output: shorten(render(trace.tool_output), 1_000),
    files_read: trace.files_read,
    files_modified: trace.files_modified,
  }));
  const responses = traces.filter((trace) => trace.final_response).slice(-4).map((trace) => ({ trace_id: trace.id, text: shorten(trace.final_response!, 3_000) }));
  return { prompts, actions, responses };
}

function reflectionPrompt(evidence: Record<string, unknown>): string {
  return `You are Termyte's reflection engine. Convert this completed coding-agent session into one concise, reusable project experience.

Rules:
- Use only the supplied evidence. Do not claim success unless a command result or final response supports it.
- Separate what worked, failed, was corrected, remains unfinished, and is a reusable project pattern.
- Empty arrays are valid. Keep every item concrete and short.
- Return JSON only with exactly these fields: lesson (string), worked (string[]), failed (string[]), corrections (string[]), patterns (string[]), unfinished (string[]).

Session evidence:
${JSON.stringify(evidence)}`;
}

function parseReflection(value: string): ReflectionOutput {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const lesson = requiredString(parsed.lesson, "lesson");
  return {
    lesson,
    worked: strings(parsed.worked),
    failed: strings(parsed.failed),
    corrections: strings(parsed.corrections),
    patterns: strings(parsed.patterns),
    unfinished: strings(parsed.unfinished),
  };
}

function renderExperience(value: ReflectionOutput): string {
  const sections: Array<[string, string[]]> = [
    ["Worked", value.worked],
    ["Failed", value.failed],
    ["Developer corrections", value.corrections],
    ["Project patterns", value.patterns],
    ["Unfinished or uncertain", value.unfinished],
  ];
  return [`Lesson: ${value.lesson}`, ...sections.filter(([, items]) => items.length > 0).map(([title, items]) => `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`)].join("\n\n");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`reflection field '${name}' must be a non-empty string`);
  return shorten(value.trim(), 1_000);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("reflection list field must be an array");
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8).map((item) => shorten(item.trim(), 500));
}

function render(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function shorten(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}
