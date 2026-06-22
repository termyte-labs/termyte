import type { ExtractedMemory } from "../types.js";
import type { GeminiClient } from "./gemini.js";
import { transformExtractionResults } from "./memories.js";

export interface ExtractionResult {
  memories: ExtractedMemory[];
  rawTraceLength: number;
}

export async function extractMemoriesFromTrace(
  client: GeminiClient,
  trace: string,
  repoScope: string,
  sourceIds: string[],
): Promise<ExtractionResult> {
  const results = await client.extractMemories(trace, repoScope);
  const memories = transformExtractionResults(results, sourceIds);
  return {
    memories,
    rawTraceLength: trace.length,
  };
}

export function buildTraceSummary(events: Array<{ summary: string; eventType: string }>): string {
  return events
    .map((e) => `[${e.eventType}] ${e.summary}`)
    .join("\n");
}
