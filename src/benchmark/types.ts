export type BenchmarkSuite = "longmemeval" | "locomo" | "memoryagent" | "scale" | "custom";
export type BenchmarkTrack = "retrieval" | "pipeline";

export interface BenchmarkDocument {
  id: string;
  content: string;
  title?: string;
  files?: string[];
  metadata?: Record<string, unknown>;
  /** Candidate namespace. Public suites such as LongMemEval use one isolated haystack per question. */
  scope?: string;
}

export interface BenchmarkQuery {
  id: string;
  query: string;
  relevantDocumentIds: string[];
  harmfulDocumentIds?: string[];
  scope?: string;
}

export interface BenchmarkDataset {
  name: string;
  version: string;
  suite: BenchmarkSuite;
  documents: BenchmarkDocument[];
  queries: BenchmarkQuery[];
}

export interface BenchmarkSearchResult {
  documentId: string;
  score: number;
}

export interface MemoryBenchmarkAdapter {
  readonly name: string;
  reset(): Promise<void>;
  ingest(documents: readonly BenchmarkDocument[]): Promise<void>;
  search(query: string, limit: number, options?: { scope?: string }): Promise<BenchmarkSearchResult[]>;
  stats(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

export interface QueryEvaluation {
  queryId: string;
  query: string;
  relevantDocumentIds: string[];
  harmfulDocumentIds: string[];
  returnedDocumentIds: string[];
  latencyMs: number;
  recallAt: Record<string, number>;
  precisionAt: Record<string, number>;
  reciprocalRank: number;
  ndcgAt10: number;
  abstentionCorrect: boolean;
  harmfulRecall: number;
}
