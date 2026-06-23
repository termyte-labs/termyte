import type Database from "better-sqlite3";
import type { GeminiClient } from "../extraction/gemini.js";
import { consolidateProject, listActiveScopes, listActiveMemoriesForScope, type ConsolidateOptions, type ConsolidationResult, type ConsolidationPlan, type ConsolidationAction } from "./agent.js";

export { consolidateProject, listActiveScopes, listActiveMemoriesForScope };
export type { ConsolidateOptions, ConsolidationResult, ConsolidationPlan, ConsolidationAction };

export async function runConsolidation(
  db: Database.Database,
  apiKey: string,
  options: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const { createGeminiClient } = await import("../extraction/gemini.js");
  const gemini = createGeminiClient(apiKey);
  return consolidateProject(db, gemini, options);
}
