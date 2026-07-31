/**
 * XML observation + summary parser for Termyte.
 *
 * Simplified grammar:
 *
 *   <observation>
 *     <type>bugfix|convention|warning|procedure|fact</type>
 *     <title>One-line summary</title>
 *     <description>Detailed explanation</description>
 *     <files_read><file>path</file></files_read>
 *     <files_modified><file>path</file></files_modified>
 *   </observation>
 *
 *   <summary>
 *     <summary_text>One paragraph summary</summary_text>
 *     <key_changes><change>...</change></key_changes>
 *     <key_learnings><learning>...</learning></key_learnings>
 *   </summary>
 *
 *   <skip_summary />
 */

const VALID_TYPES = new Set([
  "bugfix", "convention", "warning", "procedure", "fact",
]);

export interface ParsedObservation {
  type: string;
  title: string;
  description: string | null;
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  summary_text: string | null;
  key_changes: string[];
  key_learnings: string[];
  skipped?: boolean;
}

export type ParseResult =
  | { valid: true; observations: ParsedObservation[]; summary: ParsedSummary | null }
  | { valid: false };

export function parseAgentXml(raw: string): ParseResult {
  if (typeof raw !== "string" || !raw.trim()) {
    return { valid: false };
  }

  const stripped = stripFences(raw);

  // Skip sentinel.
  if (/<skip_summary\s*\/>/.test(stripped)) {
    return {
      valid: true,
      observations: [],
      summary: { summary_text: null, key_changes: [], key_learnings: [], skipped: true },
    };
  }

  const firstRoot = /<(observation|summary)\b/i.exec(stripped);
  if (!firstRoot) return { valid: false };

  const rootName = firstRoot[1].toLowerCase();
  if (rootName === "observation") {
    const observations = parseObservationBlocks(stripped);
    if (observations.length === 0) return { valid: false };
    return { valid: true, observations, summary: null };
  }

  const summary = parseSummaryBlock(stripped);
  if (!summary) return { valid: false };
  return { valid: true, observations: [], summary };
}

function stripFences(text: string): string {
  const match = text.match(/^\s*```(?:xml)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : text;
}

function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`);
  const match = regex.exec(content);
  if (!match) return null;
  const trimmed = match[1].trim();
  return trimmed === "" ? null : trimmed;
}

function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];
  const arrayRegex = new RegExp(`<${arrayName}>([\\s\\S]*?)</${arrayName}>`);
  const arrayMatch = arrayRegex.exec(content);
  if (!arrayMatch) return elements;
  const elementRegex = new RegExp(`<${elementName}>([\\s\\S]*?)</${elementName}>`, "g");
  let elMatch;
  while ((elMatch = elementRegex.exec(arrayMatch[1])) !== null) {
    const trimmed = elMatch[1].trim();
    if (trimmed) elements.push(trimmed);
  }
  return elements;
}

function parseObservationBlocks(text: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];
  const regex = /<observation>([\s\S]*?)<\/observation>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const content = match[1];
    const rawType = extractField(content, "type");
    const title = extractField(content, "title");
    const description = extractField(content, "description");
    const files_read = extractArrayElements(content, "files_read", "file");
    const files_modified = extractArrayElements(content, "files_modified", "file");

    const type = rawType && VALID_TYPES.has(rawType) ? rawType : "fact";

    if (!title && !description) continue;

    observations.push({ type, title: title ?? "(untitled)", description, files_read, files_modified });
  }
  return observations;
}

function parseSummaryBlock(text: string): ParsedSummary | null {
  const match = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  if (!match) return null;
  const content = match[1];
  const summary_text = extractField(content, "summary_text");
  const key_changes = extractArrayElements(content, "key_changes", "change");
  const key_learnings = extractArrayElements(content, "key_learnings", "learning");

  if (!summary_text && key_changes.length === 0 && key_learnings.length === 0) return null;
  return { summary_text, key_changes, key_learnings };
}
