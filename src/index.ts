/**
 * Public API surface.
 *
 * Programmatic users import types and high-level classes.
 * The rest of Termyte is internal.
 */
export * from "./shared/types.js";
export { Store } from "./storage/store.js";
export { openDatabase, closeDatabase, defaultDbPath, type DatabaseContext } from "./storage/connection.js";

export { parseAgentXml, type ParsedObservation, type ParsedSummary, type ParseResult } from "./context/observations/parser.js";
export { Observer, type ObserverConfig } from "./context/observations/pipeline.js";
export type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from "./context/observations/provider.js";
export { OpenAICompatibleProvider, type OpenAIProviderConfig } from "./context/observations/openai-provider.js";
export { buildSystemPrompt, buildObservationPrompt, buildConsolidationPrompt, buildSummaryPrompt } from "./context/observations/prompts.js";

export {
  type EmbeddingsProvider,
  NoOpEmbeddingsProvider,
} from "./context/retrieval/embeddings.js";
export { LocalEmbeddingsProvider, detectRepoId, detectWorkspaceRoot, type LocalEmbeddingsConfig, type LocalModelId } from "./context/retrieval/local-embeddings.js";
export { FTSSearch, type FTSSearchOptions } from "./context/retrieval/fts.js";
export { VectorSearch, type VectorSearchOptions, type VectorSearchResult } from "./context/retrieval/vector.js";
export {
  HybridSearch,
  type HybridSearchOptions,
  type HybridSearchResult,
} from "./context/retrieval/hybrid.js";

export {
  type Platform,
  type PlatformAdapter,
  type NormalizedEvent,
  adapterFor,
  ClaudeCodeAdapter as CaptureClaudeCodeAdapter,
  CodexAdapter as CaptureCodexAdapter,
  Ingestor,
  extractFilesFromEvent,
  type ExtractedFiles,
} from "./capture/index.js";

export { HookRunner, type HookRunnerConfig } from "./agents/hooks/runner.js";
export { ContextBuilder, renderContext, renderHybridResults, type ContextInput, type ContextOutput } from "./context/builder.js";
export { checkFreshness, type FreshnessResult, type FreshnessState } from "./context/freshness.js";
export { TaskStateService, TaskVersionConflict } from "./tasks/service.js";
export { TaskDetectionService, type TaskDetectionInput, type TaskDetectionResult } from "./tasks/detection.js";
export { WorkThreadObservationStore, WorkThreadObservationSchema, type WorkThreadObservationInput } from "./tasks/observations.js";

export { loadConfig, type TermyteConfig } from "./cli/config.js";
export { runMcpServer } from "./server/mcp/server.js";
export {
  type AgentAdapter,
  type AgentAdapterId,
  type AgentInvokeOptions,
  type AgentInvokeResult,
  type AgentInvocationError,
  ClaudeCodeAdapter,
  CodexAdapter,
  FakeAdapter,
  createAdapter,
  discoverAdapter,
} from "./agents/synthesis/index.js";

import { Store } from "./storage/store.js";
import { Observer } from "./context/observations/pipeline.js";
import { type OpenAIProviderConfig } from "./context/observations/openai-provider.js";
import { type LocalModelId } from "./context/retrieval/local-embeddings.js";
import { NoOpEmbeddingsProvider } from "./context/retrieval/embeddings.js";
import { FTSSearch } from "./context/retrieval/fts.js";
import { VectorSearch } from "./context/retrieval/vector.js";
import { HybridSearch } from "./context/retrieval/hybrid.js";
import { ContextBuilder } from "./context/builder.js";
import { HookRunner } from "./agents/hooks/runner.js";
import { createEmbeddingsProvider, createLLMProvider } from "./runtime/providers.js";

export interface TermyteOptions {
  dbPath?: string;
  llm: OpenAIProviderConfig;
  /**
   * Local embedding model. Default: "nomic-embed" (Nomic Embed Text v1.5,
   * 768 dims, runs locally via @huggingface/transformers — no API calls).
   * Pass `model: null` to disable embeddings (FTS-only retrieval).
   */
  embeddings?: { model: LocalModelId | null };
}

export interface TermyteInstance {
  store: Store;
  observer: Observer;
  runner: HookRunner;
  search: HybridSearch;
  context: ContextBuilder;
  close(): void;
}

export function createTermyte(options: TermyteOptions): TermyteInstance {
  const store = new Store(options.dbPath ?? "./termyte.db");
  const llm = createLLMProvider(options.llm);
  const embeddings = options.embeddings?.model === null
    ? new NoOpEmbeddingsProvider()
    : createEmbeddingsProvider(options.embeddings?.model);
  const observer = new Observer({ store, llm, embeddings });
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const search = new HybridSearch({ fts, vector, embeddings, feedbackStore: store });
  const context = new ContextBuilder(store, search, llm);
  // Library callers may still use explicit trace/episode processing. The
  // installed CLI enables session consolidation at the runtime boundary.
  const runner = new HookRunner({ store, observer });
  return { store, observer, runner, search, context, close: () => store.close() };
}
