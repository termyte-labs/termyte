/**
 * Zod schemas for validating LLM output.
 * Adapted from agentmemory's src/eval/schemas.ts.
 *
 * These provide a second validation gate after the regex XML parser,
 * ensuring LLM output conforms to expected shapes before persistence.
 */

import { z } from "zod";

export const ObservationSchema = z.object({
  type: z.enum(["bugfix", "convention", "warning", "procedure", "fact"]),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  files_read: z.array(z.string()).optional().default([]),
  files_modified: z.array(z.string()).optional().default([]),
});

export const MemorySchema = z.object({
  type: z.enum(["bugfix", "convention", "warning", "procedure", "fact"]),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const SummarySchema = z.object({
  summary_text: z.string().min(1),
  key_changes: z.array(z.string()).optional().default([]),
  key_learnings: z.array(z.string()).optional().default([]),
});

const VALID_TYPES = ["bugfix", "convention", "warning", "procedure", "fact"] as const;

export function validateObservation(parsed: any): boolean {
  if (!parsed || !parsed.type) return false;
  if (!VALID_TYPES.includes(parsed.type)) return false;
  if (typeof parsed.title !== "string" || parsed.title.length < 1) return false;
  return true;
}

export function validateMemory(parsed: any): boolean {
  if (!parsed || !parsed.type) return false;
  if (!VALID_TYPES.includes(parsed.type)) return false;
  if (typeof parsed.title !== "string" || parsed.title.length < 1) return false;
  return true;
}

export function validateSummary(parsed: any): boolean {
  if (!parsed) return false;
  if (typeof parsed.summary_text !== "string" || parsed.summary_text.length < 1) return false;
  return true;
}