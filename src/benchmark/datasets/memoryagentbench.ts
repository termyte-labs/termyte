import type { BenchmarkDataset, BenchmarkDocument, BenchmarkQuery } from "../types.js";

interface MemoryAgentBenchRow {
  sample_id?: string;
  id?: string;
  context?: string | string[] | { chunks?: string[]; text?: string };
  contexts?: string[] | Array<{ id?: string; text?: string }>;
  chunks?: string[] | Array<{ id?: string; text?: string }>;
  context_chunks?: string[] | Array<{ id?: string; text?: string }>;
  query_and_answers?: Array<unknown>;
  query_answer_pairs?: Array<unknown>;
  qa_pairs?: Array<unknown>;
  qa?: Array<unknown>;
  queries?: Array<unknown>;
}

export function loadMemoryAgentBenchDataset(raw: string, limit?: number): BenchmarkDataset {
  const parsed = JSON.parse(raw) as unknown;
  const rows = normalizeRows(parsed).slice(0, limit);
  const documents: BenchmarkDocument[] = [];
  const queries: BenchmarkQuery[] = [];

  rows.forEach((row, rowIndex) => {
    const sampleId = row.sample_id ?? row.id ?? `sample_${rowIndex.toString().padStart(3, "0")}`;
    const chunks = extractChunks(row);
    if (chunks.length === 0) {
      throw new Error(`MemoryAgentBench row ${sampleId} does not contain any context chunks.`);
    }

    const chunkIds = chunks.map((chunk, chunkIndex) => `${sampleId}::chunk_${chunkIndex.toString().padStart(3, "0")}`);
    chunks.forEach((chunk, chunkIndex) => {
      documents.push({
        id: chunkIds[chunkIndex]!,
        scope: sampleId,
        title: `${sampleId} chunk ${chunkIndex + 1}`,
        content: chunk,
        metadata: {
          rowIndex,
          chunkIndex,
          chunkCount: chunks.length,
        },
      });
    });

    const qaPairs = extractQueryAnswerPairs(row);
    qaPairs.forEach((pair, pairIndex) => {
      const normalized = normalizeQueryPair(pair);
      if (!normalized.query) {
        throw new Error(`Invalid MemoryAgentBench query pair in ${sampleId}.`);
      }
      queries.push({
        id: normalized.id ?? `${sampleId}::qa_${pairIndex.toString().padStart(3, "0")}`,
        scope: sampleId,
        query: normalized.query,
        relevantDocumentIds: resolveRelevantIds(normalized, chunkIds),
        harmfulDocumentIds: resolveHarmfulIds(normalized, chunkIds),
      });
    });
  });

  return {
    name: "MemoryAgentBench",
    version: "source",
    suite: "memoryagent",
    documents,
    queries,
  };
}

function normalizeRows(parsed: unknown): MemoryAgentBenchRow[] {
  if (Array.isArray(parsed)) return parsed as MemoryAgentBenchRow[];
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of ["data", "items", "rows", "samples"]) {
      const value = record[key];
      if (Array.isArray(value)) return value as MemoryAgentBenchRow[];
    }
  }
  throw new Error("MemoryAgentBench dataset must be a JSON array or an object with data/items/rows/samples.");
}

function extractChunks(row: MemoryAgentBenchRow): string[] {
  const candidate = row.contexts ?? row.chunks ?? row.context_chunks ?? row.context;
  if (typeof candidate === "string") return splitIntoChunks(candidate);
  if (Array.isArray(candidate)) {
    return candidate.flatMap((entry) => {
      if (typeof entry === "string") return splitIntoChunks(entry);
      if (entry && typeof entry === "object") {
        const text = (entry as { text?: string }).text;
        return typeof text === "string" ? splitIntoChunks(text) : [];
      }
      return [];
    });
  }
  if (candidate && typeof candidate === "object") {
    const text = (candidate as { text?: string; chunks?: string[] }).text;
    if (typeof text === "string") return splitIntoChunks(text);
    const chunks = (candidate as { chunks?: string[] }).chunks;
    if (Array.isArray(chunks)) return chunks.flatMap((chunk) => splitIntoChunks(chunk));
  }
  return [];
}

function splitIntoChunks(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function extractQueryAnswerPairs(row: MemoryAgentBenchRow): Array<unknown> {
  return row.query_and_answers
    ?? row.query_answer_pairs
    ?? row.qa_pairs
    ?? row.qa
    ?? row.queries
    ?? [];
}

interface NormalizedQueryPair {
  id?: string;
  query?: string;
  answer?: string;
  relevantDocumentIds?: string[];
  relevantChunkIndexes?: number[];
  harmfulDocumentIds?: string[];
  harmfulChunkIndexes?: number[];
}

function normalizeQueryPair(value: unknown): NormalizedQueryPair {
  if (Array.isArray(value)) {
    return {
      id: typeof value[2] === "string" ? value[2] : undefined,
      query: typeof value[0] === "string" ? value[0] : undefined,
      answer: typeof value[1] === "string" ? value[1] : undefined,
    };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      id: stringValue(record, "qa_pair_id") ?? stringValue(record, "id"),
      query: stringValue(record, "query") ?? stringValue(record, "question") ?? stringValue(record, "prompt"),
      answer: stringValue(record, "answer") ?? stringValue(record, "ground_truth") ?? stringValue(record, "expected_answer"),
      relevantDocumentIds: stringArrayValue(record, "relevantDocumentIds") ?? stringArrayValue(record, "relevant_document_ids"),
      relevantChunkIndexes: numberArrayValue(record, "relevant_chunk_indexes") ?? numberArrayValue(record, "relevant_context_indexes"),
      harmfulDocumentIds: stringArrayValue(record, "harmfulDocumentIds") ?? stringArrayValue(record, "harmful_document_ids"),
      harmfulChunkIndexes: numberArrayValue(record, "harmful_chunk_indexes"),
    };
  }
  return {};
}

function resolveRelevantIds(pair: NormalizedQueryPair, chunkIds: string[]): string[] {
  if (pair.relevantDocumentIds && pair.relevantDocumentIds.length > 0) return pair.relevantDocumentIds;
  if (pair.relevantChunkIndexes && pair.relevantChunkIndexes.length > 0) {
    return pair.relevantChunkIndexes.map((index) => chunkIds[index]).filter((value): value is string => Boolean(value));
  }
  return chunkIds.slice(0, 1);
}

function resolveHarmfulIds(pair: NormalizedQueryPair, chunkIds: string[]): string[] | undefined {
  if (pair.harmfulDocumentIds && pair.harmfulDocumentIds.length > 0) return pair.harmfulDocumentIds;
  if (pair.harmfulChunkIndexes && pair.harmfulChunkIndexes.length > 0) {
    return pair.harmfulChunkIndexes.map((index) => chunkIds[index]).filter((value): value is string => Boolean(value));
  }
  return undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function stringArrayValue(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : undefined;
}

function numberArrayValue(record: Record<string, unknown>, key: string): number[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "number") ? value as number[] : undefined;
}
