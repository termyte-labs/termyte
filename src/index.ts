/**
 * Public API surface.
 *
 * Programmatic users import the types and the high-level classes they
 * need; the rest of Termyte is internal.
 */
export * from "./core/types.js";
export { Store } from "./storage/store.js";
export { openDatabase, closeDatabase, defaultDbPath, type DatabaseContext } from "./storage/connection.js";

export { parseAgentXml, type ParsedObservation, type ParsedSummary, type ParseResult } from "./observer/parser.js";
export { Observer, type ObserverConfig } from "./observer/pipeline.js";
export type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from "./observer/provider.js";
export { OpenAICompatibleProvider, type OpenAIProviderConfig } from "./observer/openai-provider.js";
export { buildSystemPrompt, buildObservationPrompt, buildSummaryPrompt } from "./observer/prompts.js";

export {
  type EmbeddingsProvider,
  type OpenAIEmbeddingsConfig,
  OpenAIEmbeddingsProvider,
  NoOpEmbeddingsProvider,
} from "./retrieval/embeddings.js";
export { FTSSearch, type FTSSearchOptions } from "./retrieval/fts.js";
export { VectorSearch, type VectorSearchOptions, type VectorSearchResult } from "./retrieval/vector.js";
export {
  HybridSearch,
  type HybridSearchOptions,
  type HybridSearchResult,
} from "./retrieval/hybrid.js";

export {
  type Platform,
  type PlatformAdapter,
  type NormalizedEvent,
  adapterFor,
  ClaudeCodeAdapter,
  CodexAdapter,
  OpenCodeAdapter,
  CursorAdapter,
  Ingestor,
  extractFilesFromEvent,
  type ExtractedFiles,
} from "./capture/index.js";

export { HookRunner, type HookRunnerConfig } from "./hooks/runner.js";
export { ContextBuilder, renderContext, renderHybridResults, type ContextInput, type ContextOutput } from "./context/builder.js";

export { loadConfig, type TermyteConfig } from "./cli/config.js";

import { Store } from "./storage/store.js";
import { Observer } from "./observer/pipeline.js";
import { OpenAICompatibleProvider, type OpenAIProviderConfig } from "./observer/openai-provider.js";
import { OpenAIEmbeddingsProvider, NoOpEmbeddingsProvider, type OpenAIEmbeddingsConfig } from "./retrieval/embeddings.js";
import { FTSSearch } from "./retrieval/fts.js";
import { VectorSearch } from "./retrieval/vector.js";
import { HybridSearch } from "./retrieval/hybrid.js";
import { ContextBuilder } from "./context/builder.js";
import { HookRunner } from "./hooks/runner.js";

/** Convenience configuration for a fully-wired Termyte instance. */
export interface TermyteOptions {
  dbPath?: string;
  llm: OpenAIProviderConfig;
  embeddings?: OpenAIEmbeddingsConfig;
}

export interface TermyteInstance {
  store: Store;
  observer: Observer;
  runner: HookRunner;
  search: HybridSearch;
  context: ContextBuilder;
  close(): void;
}

/**
 * Construct a fully-wired Termyte with the given LLM and optional
 * embeddings provider. If `embeddings` is omitted, semantic search is
 * disabled and search degrades to FTS-only.
 */
export function createTermyte(options: TermyteOptions): TermyteInstance {
  const store = new Store(options.dbPath ?? "./termyte.db");
  const llm = new OpenAICompatibleProvider(options.llm);
  const embeddings = options.embeddings
    ? new OpenAIEmbeddingsProvider(options.embeddings)
    : new NoOpEmbeddingsProvider();
  const observer = new Observer({ store, llm, embeddings });
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const search = new HybridSearch({ fts, vector, embeddings });
  const context = new ContextBuilder(store, search);
  const runner = new HookRunner({ store, observer });
  return {
    store,
    observer,
    runner,
    search,
    context,
    close: () => store.close(),
  };
}
