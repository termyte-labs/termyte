import { FTSSearch } from "../../context/retrieval/fts.js";
import { FakeLLMProvider } from "../../context/observations/fake-provider.js";
import { MemoryPipeline } from "../../context/pipeline/memory-pipeline.js";
import { Store } from "../../storage/store.js";
import type { BenchmarkDocument, BenchmarkSearchResult, MemoryBenchmarkAdapter } from "../types.js";

/**
 * Benchmark adapter that runs each benchmark document through the real
 * trace -> observation -> memory pipeline using the deterministic offline
 * LLM provider, then searches the resulting memory corpus with FTS.
 */
export class TermytePipelineBenchmarkAdapter implements MemoryBenchmarkAdapter {
  readonly name = "termyte-pipeline";
  private store = new Store(":memory:");
  private pipeline = new MemoryPipeline({
    store: this.store,
    llm: new FakeLLMProvider(),
  });
  private ids = new Map<number, string>();

  async reset(): Promise<void> {
    this.store.close();
    this.store = new Store(":memory:");
    this.pipeline = new MemoryPipeline({
      store: this.store,
      llm: new FakeLLMProvider(),
    });
    this.ids.clear();
  }

  async ingest(documents: readonly BenchmarkDocument[]): Promise<void> {
    for (const document of documents) {
      const scope = document.scope ?? "benchmark";
      const sessionId = `benchmark:${scope}`;
      this.store.upsertSession(sessionId, "benchmark", scope, "/benchmark");
      const trace = this.store.insertTrace({
        session_id: sessionId,
        timestamp: Date.now(),
        event_type: "tool_use",
        tool_name: "Bash",
        tool_input: { command: document.content },
        tool_output: { content: document.content, title: document.title ?? null },
        files_read: document.files ?? null,
        files_modified: null,
        user_prompt: null,
        final_response: null,
      });
      this.pipeline.ingestTrace(trace.id);
      this.ids.set(trace.id, document.id);
    }

    await this.pipeline.runUntilIdle("benchmark");
  }

  async search(query: string, limit: number, options: { scope?: string } = {}): Promise<BenchmarkSearchResult[]> {
    return new FTSSearch(this.store).search({ query, repo_id: options.scope ?? "benchmark", limit }).map((memory, index) => ({
      documentId: this.ids.get(memory.source_trace_ids[0] ?? memory.id) ?? memory.title,
      score: 1 / (index + 1),
    }));
  }

  async stats(): Promise<Record<string, number>> {
    return {
      documents: this.ids.size,
      memories: this.store.getRecentMemories(10_000).length,
    };
  }

  async close(): Promise<void> {
    this.store.close();
  }
}
