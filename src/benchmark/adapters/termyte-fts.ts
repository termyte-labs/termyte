import { Store } from "../../storage/store.js";
import { FTSSearch } from "../../context/retrieval/fts.js";
import type { BenchmarkDocument, BenchmarkSearchResult, MemoryBenchmarkAdapter } from "../types.js";

export class TermyteFtsBenchmarkAdapter implements MemoryBenchmarkAdapter {
  readonly name = "termyte-fts";
  private store = new Store(":memory:");
  private ids = new Map<number, string>();

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
      this.ids.set(memory.id, document.id);
    }
  }

  async search(query: string, limit: number, options: { scope?: string } = {}): Promise<BenchmarkSearchResult[]> {
    return new FTSSearch(this.store).search({ query, repo_id: options.scope ?? "benchmark", limit }).map((memory, index) => ({
      documentId: this.ids.get(memory.id)!,
      score: 1 / (index + 1),
    }));
  }

  async stats(): Promise<Record<string, number>> {
    return { documents: this.ids.size };
  }

  async close(): Promise<void> {
    this.store.close();
  }
}
