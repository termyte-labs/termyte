import { FTSSearch } from "../../retrieval/fts.js";
import { HybridSearch } from "../../retrieval/hybrid.js";
import { LocalEmbeddingsProvider, type LocalModelId } from "../../retrieval/local-embeddings.js";
import { VectorSearch } from "../../retrieval/vector.js";
import { Store } from "../../storage/store.js";
import type { BenchmarkDocument, BenchmarkSearchResult, MemoryBenchmarkAdapter } from "../types.js";

/** Runs the actual Termyte FTS + persisted-memory vector + RRF path. */
export class TermyteHybridBenchmarkAdapter implements MemoryBenchmarkAdapter {
  readonly name: string;
  private store = new Store(":memory:");
  private ids = new Map<number, string>();
  private readonly embeddings: LocalEmbeddingsProvider;

  constructor(model: LocalModelId = "bge-small") {
    this.name = `termyte-hybrid-${model}`;
    this.embeddings = new LocalEmbeddingsProvider({ model });
  }

  async reset(): Promise<void> {
    this.store.close();
    this.store = new Store(":memory:");
    this.ids.clear();
  }

  async ingest(documents: readonly BenchmarkDocument[]): Promise<void> {
    for (const document of documents) {
      const scope = document.scope ?? "benchmark";
      const sessionId = `benchmark:${scope}`;
      this.store.upsertSession(sessionId, "benchmark", scope, "/benchmark");
      const memory = this.store.insertMemory({
        session_id: sessionId,
        repo_id: scope,
        workspace_root: "/benchmark",
        type: "fact",
        title: document.title ?? document.content.slice(0, 120),
        description: document.content,
        files_read: document.files ?? [],
        files_modified: [],
        source_observation_ids: [],
        source_trace_ids: [],
        created_at: Date.now(),
        embedding: null,
      });
      this.store.updateMemoryEmbedding(memory.id, await this.embeddings.embed(document.content));
      this.ids.set(memory.id, document.id);
    }
  }

  async search(query: string, limit: number, options: { scope?: string } = {}): Promise<BenchmarkSearchResult[]> {
    const search = new HybridSearch({
      fts: new FTSSearch(this.store),
      vector: new VectorSearch(this.store),
      embeddings: this.embeddings,
      feedbackStore: this.store,
    });
    // Calling ContextBuilder would add injection side effects, so benchmarks
    // call the same retrieval engine directly.
    return (await search.search({ query, repo_id: options.scope ?? "benchmark", limit })).map((result) => ({
      documentId: this.ids.get(result.memory.id)!,
      score: result.combined_score,
    }));
  }

  async stats(): Promise<Record<string, number>> {
    return {
      documents: this.ids.size,
      embedding_dimensions: this.embeddings.dimensions,
      sqlite_vec_active: this.store.isMemoryVectorIndexAvailable(this.embeddings.dimensions) ? 1 : 0,
    };
  }

  async close(): Promise<void> {
    this.store.close();
  }
}
