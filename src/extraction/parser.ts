import type { ParseResult, ParsedObservation, ParsedSummary } from "../types.js";

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function extractAllTags(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractFilesFromSection(xml: string, sectionTag: string): string[] {
  const section = extractTag(xml, sectionTag);
  if (!section) return [];
  return extractAllTags(section, "file");
}

function extractObservations(xml: string): ParsedObservation[] {
  const observationBlocks = extractAllTags(xml, "observation");
  return observationBlocks.map((block) => ({
    type: extractTag(block, "type") ?? "discovery",
    title: extractTag(block, "title"),
    subtitle: extractTag(block, "subtitle"),
    facts: extractAllTags(block, "fact"),
    narrative: extractTag(block, "narrative"),
    concepts: extractAllTags(block, "concept"),
    files_read: extractFilesFromSection(block, "files_read"),
    files_modified: extractFilesFromSection(block, "files_modified"),
  }));
}

function extractSummary(xml: string): ParsedSummary | null {
  const summaryBlock = extractTag(xml, "summary");
  if (!summaryBlock) return null;

  const skipped = extractTag(summaryBlock, "skipped");
  if (skipped === "true") {
    return {
      request: null,
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      notes: null,
      skipped: true,
      skip_reason: extractTag(summaryBlock, "skip_reason"),
    };
  }

  return {
    request: extractTag(summaryBlock, "request"),
    investigated: extractTag(summaryBlock, "investigated"),
    learned: extractTag(summaryBlock, "learned"),
    completed: extractTag(summaryBlock, "completed"),
    next_steps: extractTag(summaryBlock, "next_steps"),
    notes: extractTag(summaryBlock, "notes"),
    skipped: false,
  };
}

function hasObservationXml(text: string): boolean {
  return /<observations>[\s\S]*?<\/observations>/i.test(text);
}

function hasSummaryXml(text: string): boolean {
  return /<summary>[\s\S]*?<\/summary>/i.test(text);
}

export function parseXml(xml: string): ParseResult {
  if (!xml || xml.trim().length === 0) {
    return { valid: false };
  }

  if (!hasObservationXml(xml) && !hasSummaryXml(xml)) {
    return { valid: false };
  }

  const observations = extractObservations(xml);
  const summary = extractSummary(xml);

  if (observations.length === 0 && !summary) {
    return { valid: false };
  }

  return {
    valid: true,
    observations,
    summary,
  };
}


export function isXmlClean(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("<observations>") || trimmed.startsWith("<summary>")) {
    return true;
  }
  if (/<observations>[\s\S]*<\/observations>/i.test(trimmed)) {
    return true;
  }
  if (/<summary>[\s\S]*<\/summary>/i.test(trimmed)) {
    return true;
  }
  return false;
}
