/**
 * System prompt + per-trace / per-observation prompt builders for Termyte.
 *
 * Two-stage pipeline:
 *   1. Observation extraction: trace → <observation> XML
 *   2. Memory consolidation: observations → <observation> XML (memory)
 */

export const VALID_TYPES = [
  "bugfix",
  "convention",
  "warning",
  "procedure",
  "fact",
] as const;

const SYSTEM_IDENTITY = `You are a Termyte observer. Your job is to extract durable technical knowledge from agent tool executions. You do not have access to tools. Create structured observations from the traces provided to you.`;

const RECORDING_FOCUS = `WHAT TO RECORD
Focus on durable technical signal that is useful for future sessions:
- Bugfixes: what was broken and how it was fixed
- Conventions: project-specific patterns, naming, structure rules
- Warnings: pitfalls, footguns, things to avoid
- Procedures: multi-step processes for common tasks
- Facts: objective information about the codebase

Use specific details: filenames, function names, error messages, config values.`;

const SKIP_GUIDANCE = `WHEN TO SKIP
Skip operations with no durable signal:
- Empty status checks or simple listings
- Package installations with no errors
- Trivial file reads that return nothing
- Repetitive operations already documented

If nothing durable is found, return a single self-closing <skip_summary /> tag.`;

const TYPE_GUIDANCE = `**type**: EXACTLY one of:
  - bugfix: something was broken, now fixed
  - convention: project-specific pattern, naming rule, or structure convention
  - warning: pitfall, footgun, or thing to avoid
  - procedure: multi-step process for a common task
  - fact: objective information about the codebase`;

const OUTPUT_FORMAT = `<observation>
  <type>[ bugfix | convention | warning | procedure | fact ]</type>
  <title>One-line summary</title>
  <description>Multi-line detailed explanation</description>
  <files_read>
    <file>path/to/file</file>
  </files_read>
  <files_modified>
    <file>path/to/file</file>
  </files_modified>
</observation>`;

const FOOTER = `IMPORTANT! Output ONLY the XML above. No prose, no explanations, no markdown. If nothing to record, output <skip_summary /> alone.`;

const SUMMARY_SYSTEM = `You are a Termyte session summarizer. Your job is to produce a concise summary of a coding session from its traces. Focus on what was accomplished, key decisions, files changed, and lessons learned. Output ONLY the XML requested. No prose, no markdown, no explanations.`;

export function buildSummarySystemPrompt(): string {
  return SUMMARY_SYSTEM;
}

export function buildSystemPrompt(): string {
  return [
    SYSTEM_IDENTITY, "", RECORDING_FOCUS, "", SKIP_GUIDANCE, "",
    TYPE_GUIDANCE, "", "OUTPUT FORMAT", OUTPUT_FORMAT, "", FOOTER,
  ].join("\n");
}

const CONSOLIDATION_SYSTEM = `You are a Termyte memory consolidator. Your job is to combine related observations into consolidated, deduplicated memories. Merge observations that describe the same thing. Produce concise, standalone memories that will be useful for future agent sessions.`;

export function buildConsolidationSystemPrompt(): string {
  return [
    CONSOLIDATION_SYSTEM, "", TYPE_GUIDANCE, "", "OUTPUT FORMAT", OUTPUT_FORMAT, "", FOOTER,
  ].join("\n");
}

export interface TraceForPrompt {
  id?: number;
  tool_name: string;
  tool_input: unknown;
  tool_output: unknown;
  cwd?: string;
  timestamp: number;
}

export function buildObservationPrompt(trace: TraceForPrompt): string {
  const redactedInput = redactValue(trace.tool_input, "trace.tool_input").value;
  const redactedOutput = redactValue(trace.tool_output, "trace.tool_output").value;
  const lines = [
    "<observed_tool_execution>",
    `  <tool>${escape(trace.tool_name || "unknown")}</tool>`,
    `  <time>${new Date(trace.timestamp).toISOString()}</time>`,
    trace.cwd ? `  <directory>${escape(trace.cwd)}</directory>` : "",
    redactedInput != null ? `  <input>${escape(serialize(redactedInput))}</input>` : "",
    redactedOutput != null ? `  <output>${escape(serialize(redactedOutput))}</output>` : "",
    "</observed_tool_execution>",
    "",
    "Extract observations from this tool execution. Return <observation> blocks or <skip_summary />.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function buildObservationBatchPrompt(traces: TraceForPrompt[]): string {
  return traces.map((trace, index) => [
    `<trace id="${trace.id ?? index + 1}">`,
    buildObservationPrompt(trace),
    "</trace>",
  ].join("\n")).join("\n\n");
}

/**
 * Build a prompt that consolidates multiple observations into memories.
 */
export function buildConsolidationPrompt(
  observations: { id: number; title: string; description: string | null; type: string; files_read: string[]; files_modified: string[] }[]
): string {
  const blocks = observations.map(obs => [
    `<observation_summary id="${obs.id}" type="${obs.type}">`,
    `  <title>${escape(obs.title)}</title>`,
    obs.description ? `  <description>${escape(obs.description)}</description>` : "",
    obs.files_read.length > 0 ? `  <files_read>${obs.files_read.join(", ")}</files_read>` : "",
    obs.files_modified.length > 0 ? `  <files_modified>${obs.files_modified.join(", ")}</files_modified>` : "",
    `</observation_summary>`,
  ].filter(Boolean).join("\n")).join("\n");

  return [
    "Consolidate the following observations into durable memories.",
    "Merge observations about the same thing. Remove duplicates.",
    "Each memory must be self-contained and useful for future sessions.",
    "",
    blocks,
    "",
    "Return consolidated <observation> blocks or <skip_summary /> if nothing to consolidate.",
  ].join("\n");
}

export interface SessionForPrompt {
  user_prompts: string[];
  final_response: string | null;
  files_modified: string[];
}

export function buildSessionConsolidationPrompt(input: {
  sessionId: string;
  repoId: string;
  task: unknown;
  traces: unknown[];
}): string {
  return [
    "--- COMPLETE SESSION CONSOLIDATION ---",
    "Turn the complete coding-agent session into durable, evidence-linked observations.",
    "Every trace below is available. Do not omit important failures, decisions, attempts, file changes, commands, tests, or remaining work.",
    "The task record is authoritative for task identity. Preserve the trace IDs in your reasoning; the system will attach every source trace to the stored observation.",
    "Return exactly one <observation> block, or <skip_summary /> only when the session contains no durable work.",
    `Session ID: ${input.sessionId}`,
    `Repository: ${input.repoId}`,
    "TASK RECORD:",
    JSON.stringify(input.task, null, 2),
    "ALL SESSION TRACES:",
    JSON.stringify(input.traces, null, 2),
  ].join("\n\n");
}

export function buildSummaryPrompt(input: SessionForPrompt): string {
  return [
    "--- SESSION SUMMARY ---",
    "Generate a summary of this completed agent session.",
    "",
    "User prompts during this session:",
    ...input.user_prompts.map((p) => `- ${redactText(p, "session.user_prompt")}`),
    "",
    input.final_response ? `Final response: ${redactText(input.final_response, "session.final_response")}` : "",
    "",
    "Respond in this XML format:",
    "<summary>",
    "  <summary_text>What happened in this session? One paragraph.</summary_text>",
    "  <key_changes>",
    "    <change>What was changed</change>",
    "  </key_changes>",
    "  <key_learnings>",
    "    <learning>What was learned</learning>",
    "  </key_learnings>",
    "</summary>",
    "",
    "IMPORTANT: Output ONLY the <summary> block, nothing else.",
  ].filter(Boolean).join("\n");
}

function serialize(v: unknown): string {
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
import { redactText, redactValue } from "../../shared/redaction.js";
