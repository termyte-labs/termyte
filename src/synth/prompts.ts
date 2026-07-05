/**
 * Prompt builders for the background synthesis path. Reuses the XML
 * grammar the existing Observer already understands (see
 * src/observer/prompts.ts) so the parser is shared and the agent's
 * job is just "emit Termyte XML for these traces".
 *
 * The system prompt is shaped so that any coding agent — Claude Code,
 * Codex, OpenCode, Gemini — can pick it up and produce the right
 * output without per-agent customization. Agent adapters only differ
 * in how they call the model and parse the response envelope; the
 * prompt content is the same.
 */

export const SYNTHESIS_SYSTEM_PROMPT = `You are a Termyte memory synthesizer. Your job is to convert a batch of agent tool executions into durable technical knowledge. You do not have access to tools. Output only XML — no prose, no markdown, no explanations.

WHAT TO RECORD
Focus on durable technical signal that is useful for future sessions:
- Bugfixes: what was broken and how it was fixed
- Conventions: project-specific patterns, naming, structure rules
- Warnings: pitfalls, footguns, things to avoid
- Procedures: multi-step processes for common tasks
- Facts: objective information about the codebase

Use specific details: filenames, function names, error messages, config values.

WHEN TO SKIP
Skip operations with no durable signal:
- Empty status checks or simple listings
- Package installations with no errors
- Trivial file reads that return nothing
- Repetitive operations already documented

If nothing durable is found, output a single self-closing <skip_summary /> tag.

TYPES — EXACTLY one of:
  - bugfix: something was broken, now fixed
  - convention: project-specific pattern, naming rule, or structure convention
  - warning: pitfall, footgun, or thing to avoid
  - procedure: multi-step process for a common task
  - fact: objective information about the codebase

OUTPUT FORMAT
<observation>
  <type>[bugfix|convention|warning|procedure|fact]</type>
  <title>One-line summary</title>
  <description>Multi-line detailed explanation</description>
  <files_read>
    <file>path/to/file</file>
  </files_read>
  <files_modified>
    <file>path/to/file</file>
  </files_modified>
</observation>

Return one <observation> per distinct memory. Multiple memories allowed. Do not wrap in a list. Do not add a closing tag. Output ONLY the XML above. If nothing to record, output <skip_summary /> alone.`;

export interface SynthesisTraceInput {
  id: number;
  tool_name: string | null;
  tool_input: unknown;
  tool_output: unknown;
  user_prompt: string | null;
  timestamp: number;
}

export function buildBatchPrompt(traces: SynthesisTraceInput[]): string {
  if (traces.length === 0) {
    return "No traces to synthesize. Output <skip_summary />.";
  }
  const blocks = traces.map(formatTrace);
  return [
    "You are given a batch of agent tool executions captured by Termyte.",
    "Convert them into durable memories. Output XML only.",
    "",
    ...blocks,
  ].join("\n");
}

function formatTrace(t: SynthesisTraceInput): string {
  const redactedInput = redactValue(t.tool_input, "trace.tool_input").value;
  const redactedOutput = redactValue(t.tool_output, "trace.tool_output").value;
  const lines: string[] = [];
  lines.push("<trace>");
  lines.push(`  <id>${t.id}</id>`);
  lines.push(`  <time>${new Date(t.timestamp).toISOString()}</time>`);
  if (t.user_prompt) lines.push(`  <user_prompt>${escape(redactText(t.user_prompt, "trace.user_prompt"))}</user_prompt>`);
  lines.push(`  <tool>${escape(t.tool_name ?? "unknown")}</tool>`);
  if (redactedInput != null) lines.push(`  <input>${escape(truncate(stringify(redactedInput)))}</input>`);
  if (redactedOutput != null) lines.push(`  <output>${escape(truncate(stringify(redactedOutput)))}</output>`);
  lines.push("</trace>");
  return lines.join("\n");
}

function stringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "\n...(truncated)" : s;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
import { redactText, redactValue } from "../security/redaction.js";
