/**
 * XML observation parser.
 *
 * Ported from claude-mem `src/sdk/parser.ts`. The grammar is:
 *
 *   <observation type="X" title="..." subtitle="...">
 *     <facts><fact>...</fact>...</facts>
 *     <narrative>...</narrative>
 *     <concepts><concept>...</concept>...</concepts>
 *     <files_read><file>...</file></files_read>
 *     <files_modified><file>...</file></files_modified>
 *   </observation>
 *
 *   <summary>
 *     <request>...</request>
 *     <investigated>...</investigated>
 *     <learned>...</learned>
 *     <completed>...</completed>
 *     <next_steps>...</next_steps>
 *     <notes>...</notes>
 *   </summary>
 *
 *   <skip_summary reason="..."/>
 *
 * Invalid XML returns `valid: false`; callers should drop the batch silently.
 */

const VALID_TYPES = new Set([
  "bugfix", "feature", "refactor", "change", "discovery", "decision",
]);

const VALID_CONCEPTS = new Set([
  "how-it-works", "why-it-exists", "what-changed",
  "problem-solution", "gotcha", "pattern", "trade-off",
]);

export interface ParsedObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  skipped?: boolean;
  skip_reason?: string | null;
}

export type ParseResult =
  | { valid: true; observations: ParsedObservation[]; summary: ParsedSummary | null }
  | { valid: false };

export function parseAgentXml(raw: string): ParseResult {
  if (typeof raw !== "string" || !raw.trim()) {
    return { valid: false };
  }

  const stripped = stripFences(raw);

  // Skip-summary sentinel: provider says "nothing to record".
  const skipMatch = /<skip_summary(?:\s+reason="([^"]*)")?\s*\/>/.exec(stripped);
  if (skipMatch) {
    return {
      valid: true,
      observations: [],
      summary: {
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        skipped: true,
        skip_reason: skipMatch[1] ?? null,
      },
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
  // Only strip when the entire payload is a single fenced block.
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

function extractArrayElements(
  content: string,
  arrayName: string,
  elementName: string,
): string[] {
  const elements: string[] = [];
  const arrayRegex = new RegExp(`<${arrayName}>([\\s\\S]*?)</${arrayName}>`);
  const arrayMatch = arrayRegex.exec(content);
  if (!arrayMatch) return elements;

  const arrayContent = arrayMatch[1];
  const elementRegex = new RegExp(
    `<${elementName}>([\\s\\S]*?)</${elementName}>`,
    "g",
  );
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    const trimmed = elementMatch[1].trim();
    if (trimmed) elements.push(trimmed);
  }
  return elements;
}

function parseObservationBlocks(text: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];
  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    const rawType = extractField(obsContent, "type");
    const title = extractField(obsContent, "title");
    const subtitle = extractField(obsContent, "subtitle");
    const narrative = extractField(obsContent, "narrative");
    const facts = extractArrayElements(obsContent, "facts", "fact");
    const concepts = extractArrayElements(obsContent, "concepts", "concept");
    const files_read = extractArrayElements(obsContent, "files_read", "file");
    const files_modified = extractArrayElements(
      obsContent,
      "files_modified",
      "file",
    );

    // Validate type, fall back to "discovery".
    const type = rawType && VALID_TYPES.has(rawType) ? rawType : "discovery";

    // Drop unknown concepts and strip the type-as-concept noise.
    const cleanedConcepts = concepts.filter(
      (c) => VALID_CONCEPTS.has(c) && c !== type,
    );

    if (
      !title &&
      !narrative &&
      facts.length === 0 &&
      cleanedConcepts.length === 0
    ) {
      continue;
    }

    observations.push({
      type,
      title,
      subtitle,
      facts,
      narrative,
      concepts: cleanedConcepts,
      files_read,
      files_modified,
    });
  }

  return observations;
}

function parseSummaryBlock(text: string): ParsedSummary | null {
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);
  if (!summaryMatch) return null;

  const summaryContent = summaryMatch[1];
  const request = extractField(summaryContent, "request");
  const investigated = extractField(summaryContent, "investigated");
  const learned = extractField(summaryContent, "learned");
  const completed = extractField(summaryContent, "completed");
  const next_steps = extractField(summaryContent, "next_steps");
  const notes = extractField(summaryContent, "notes");

  if (
    !request &&
    !investigated &&
    !learned &&
    !completed &&
    !next_steps
  ) {
    return null;
  }

  return { request, investigated, learned, completed, next_steps, notes };
}
