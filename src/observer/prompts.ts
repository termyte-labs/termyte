/**
 * System prompt + per-trace prompt builder for the observer LLM.
 *
 * Ported from claude-mem `src/sdk/prompts.ts`. The wording is the same
 * because the parser enforces the same grammar. A model that produced
 * correct observations for claude-mem will produce correct observations
 * for Termyte.
 */

export const VALID_TYPES = [
  "bugfix",
  "feature",
  "refactor",
  "change",
  "discovery",
  "decision",
] as const;

export const VALID_CONCEPTS = [
  "how-it-works",
  "why-it-exists",
  "what-changed",
  "problem-solution",
  "gotcha",
  "pattern",
  "trade-off",
] as const;

const SYSTEM_IDENTITY = `You are a Termyte observer, a specialized tool for creating searchable memory FOR FUTURE AGENT SESSIONS.

CRITICAL: Record what was LEARNED, BUILT, FIXED, DEPLOYED, or CONFIGURED — not what you (the observer) are doing.

You do not have access to tools. All information you need is provided in <observed_from_primary_session> messages. Create observations from what you observe; no investigation needed.`;

const RECORDING_FOCUS = `WHAT TO RECORD
Focus on durable technical signal:
- What the system NOW DOES differently (new capabilities)
- What shipped to users/production (features, fixes, configs, docs)
- Changes in technical domains (auth, data, UI, infra, DevOps, docs)
- Concrete debugging or investigative findings from logs, traces, queue state, database rows, and code-path inspection

Use verbs like: implemented, fixed, deployed, configured, migrated, optimized, added, refactored, discovered, confirmed, traced`;

const SKIP_GUIDANCE = `WHEN TO SKIP
Skip routine operations:
- Empty status checks
- Package installations with no errors
- Simple file listings with no follow-on finding
- Repetitive operations you've already documented
- File research that comes back empty or not found

If you skip, return an empty response. Do not explain the skip in prose.`;

const TYPE_GUIDANCE = `**type**: MUST be EXACTLY one of these 6 options (no other values allowed):
  - bugfix: something was broken, now fixed
  - feature: new capability or functionality added
  - refactor: code restructured, behavior unchanged
  - change: generic modification (docs, config, misc)
  - discovery: learning about existing system
  - decision: architectural/design choice with rationale`;

const CONCEPT_GUIDANCE = `**concepts**: 2-5 knowledge-type categories. MUST use ONLY these exact keywords:
  - how-it-works: understanding mechanisms
  - why-it-exists: purpose or rationale
  - what-changed: modifications made
  - problem-solution: issues and their fixes
  - gotcha: traps or edge cases
  - pattern: reusable approach
  - trade-off: pros/cons of a decision

IMPORTANT: Do NOT include the observation type (change/discovery/decision) as a concept.
Types and concepts are separate dimensions.`;

const FIELD_GUIDANCE = `**facts**: Concise, self-contained statements
  Each fact is ONE piece of information
  No pronouns — each fact must stand alone
  Include specific details: filenames, functions, values

**files**: All files touched (full paths from project root)`;

const OUTPUT_FORMAT = `<observation>
  <type>[ bugfix | feature | refactor | change | discovery | decision ]</type>
  <title>...</title>
  <subtitle>...</subtitle>
  <facts>
    <fact>...</fact>
    <fact>...</fact>
  </facts>
  <narrative>...</narrative>
  <concepts>
    <concept>...</concept>
    <concept>...</concept>
  </concepts>
  <files_read>
    <file>...</file>
  </files_read>
  <files_modified>
    <file>...</file>
  </files_modified>
</observation>`;

const FOOTER = `IMPORTANT! Do not output anything other than the observation content formatted in the XML structure above. All other output is ignored by the system.

Never reference yourself or your own actions. If there is nothing durable to record, return a single self-closing <skip_summary /> tag and nothing else.`;

export function buildSystemPrompt(): string {
  return [
    SYSTEM_IDENTITY,
    "",
    RECORDING_FOCUS,
    "",
    SKIP_GUIDANCE,
    "",
    TYPE_GUIDANCE,
    "",
    CONCEPT_GUIDANCE,
    "",
    FIELD_GUIDANCE,
    "",
    "OUTPUT FORMAT",
    "Output observations using this XML structure:",
    "",
    OUTPUT_FORMAT,
    "",
    FOOTER,
  ].join("\n");
}

export interface TraceForPrompt {
  tool_name: string;
  tool_input: unknown;
  tool_output: unknown;
  cwd?: string;
  timestamp: number;
}

export function buildObservationPrompt(trace: TraceForPrompt): string {
  return [
    "<observed_from_primary_session>",
    `  <what_happened>${escape(trace.tool_name || "unknown")}</what_happened>`,
    `  <occurred_at>${new Date(trace.timestamp).toISOString()}</occurred_at>`,
    trace.cwd ? `  <working_directory>${escape(trace.cwd)}</working_directory>` : "",
    `  <parameters>${escape(serialize(trace.tool_input))}</parameters>`,
    `  <outcome>${escape(serialize(trace.tool_output))}</outcome>`,
    "</observed_from_primary_session>",
    "",
    "Return one or more <observation>...</observation> blocks, or a single self-closing <skip_summary /> if there is nothing durable to record. Never reply with prose.",
  ].filter(Boolean).join("\n");
}

export interface SummaryForPrompt {
  request: string | null;
  final_response: string | null;
}

export function buildSummaryPrompt(input: SummaryForPrompt): string {
  return [
    "--- PROGRESS SUMMARY ---",
    "Generate a summary of the agent session that just ended.",
    "",
    `User's original request: ${input.request ?? "(unknown)"}`,
    "",
    "The agent's final response:",
    input.final_response ?? "(none)",
    "",
    "Respond in this XML format:",
    "<summary>",
    "  <request>[Short title capturing the user's request]</request>",
    "  <investigated>[What was explored?]</investigated>",
    "  <learned>[What was learned about how things work?]</learned>",
    "  <completed>[What work has been completed?]</completed>",
    "  <next_steps>[What's next in the session?]</next_steps>",
    "  <notes>[Additional insights]</notes>",
    "</summary>",
    "",
    "IMPORTANT: Output ONLY the <summary>...</summary> block, nothing else.",
  ].join("\n");
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
