import { createHash } from "node:crypto";
import type { MemoryType } from "../../shared/types.js";

export interface CanonicalMemoryInput {
  type: MemoryType | string;
  content: string;
  files: string[];
}

export interface DedupeComparable {
  id: number;
  type: MemoryType | string;
  canonical_key: string | null;
  files_read: string[];
  files_modified: string[];
  embedding: Float32Array | null;
}

export interface MemoryMergeDecision {
  keep: number;
  supersede: number;
  edgeType: "duplicates" | "supersedes";
}

export function canonicalMemoryKey(input: CanonicalMemoryInput): string {
  const normalizedContent = normalizeText(input.content)
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hash>");

  const fileScope = input.files.map(normalizePath).sort().join("|");
  return sha256(`${input.type}:${fileScope}:${normalizedContent}`);
}

export function shouldDeduplicate(a: DedupeComparable, b: DedupeComparable): boolean {
  if (a.canonical_key && b.canonical_key && a.canonical_key === b.canonical_key) {
    return true;
  }

  if (a.type !== b.type) return false;

  const overlap = fileOverlapScore(allFiles(a), allFiles(b));
  if (overlap < 0.5) return false;

  if (!a.embedding || !b.embedding) return false;
  return cosineSimilarity(a.embedding, b.embedding) >= 0.92;
}

export function chooseDuplicateWinner(input: {
  existing: { id: number; confidence: number; importance: number; created_at: number };
  incoming: { id: number; confidence: number; importance: number; created_at: number };
}): MemoryMergeDecision {
  const incomingBetter =
    input.incoming.confidence > input.existing.confidence + 0.08 ||
    (input.incoming.created_at > input.existing.created_at &&
      input.incoming.importance >= input.existing.importance);

  if (incomingBetter) {
    return { keep: input.incoming.id, supersede: input.existing.id, edgeType: "supersedes" };
  }

  return { keep: input.existing.id, supersede: input.incoming.id, edgeType: "duplicates" };
}

export function fileOverlapScore(aFiles: string[], bFiles: string[]): number {
  const a = new Set(aFiles.map(normalizePath));
  const b = new Set(bFiles.map(normalizePath));
  if (a.size === 0 || b.size === 0) return 0;

  let exact = 0;
  for (const file of a) {
    if (b.has(file)) exact++;
  }

  return exact / Math.min(a.size, b.size);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    aNorm += a[i]! * a[i]!;
    bNorm += b[i]! * b[i]!;
  }

  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "").toLowerCase();
}

function allFiles(memory: DedupeComparable): string[] {
  return [...memory.files_read, ...memory.files_modified];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

