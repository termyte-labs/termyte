import type { ExtractedMemory, MemoryType } from "../types.js";
import type { ExtractedMemoryResult } from "./gemini.js";

export function toMemoryType(raw: string): MemoryType {
  const valid: MemoryType[] = ["fact", "bugfix", "procedure", "convention", "warning"];
  return valid.includes(raw as MemoryType) ? (raw as MemoryType) : "fact";
}

export function transformExtractionResults(
  results: ExtractedMemoryResult[],
  sources: string[],
): ExtractedMemory[] {
  return results.map((r) => ({
    claim: r.claim,
    type: toMemoryType(r.type),
    language: r.language,
    sources: [...sources],
  }));
}
