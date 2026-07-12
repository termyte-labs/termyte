import type { Store } from "../storage/store.js";
import type { Trace } from "../core/types.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import type { LLMProvider, ChatOptions } from "./provider.js";
import { JobQueue } from "../pipeline/job-queue.js";
import { MemoryPipeline } from "../pipeline/memory-pipeline.js";

export interface ObserverConfig {
  store: Store;
  llm: LLMProvider;
  embeddings?: EmbeddingsProvider;
  chatOptions?: ChatOptions;
}

/** Compatibility facade whose work always executes through durable jobs. */
export class Observer {
  private readonly store: Store;
  private readonly pipeline: MemoryPipeline;
  private readonly queue: JobQueue;
  private readonly workerId = `observer-${process.pid}`;

  constructor(config: ObserverConfig) {
    this.store = config.store;
    this.pipeline = new MemoryPipeline(config);
    this.queue = new JobQueue(config.store.getDB());
  }

  enqueue(trace: Trace): void {
    this.pipeline.ingestTrace(trace.id);
  }

  enqueueMany(traces: Trace[]): void {
    this.store.transaction(() => {
      for (const trace of traces) this.pipeline.ingestTrace(trace.id);
    });
  }

  /** Process queued work under durable leases. Hooks intentionally do not call this. */
  async flush(): Promise<void> {
    await this.pipeline.runUntilIdle(this.workerId);
  }

  destroy(): void {
    // There is no in-memory work to discard.
  }

  enqueueSummary(sessionId: string): void {
    this.queue.enqueueJob({
      kind: "update_summary",
      subjectType: "summary",
      subjectId: sessionId,
    });
  }

  async processUnprocessedOnce(limit = 50): Promise<number> {
    const enqueued = this.pipeline.enqueueUnprocessedTraces(limit);
    await this.flush();
    return enqueued;
  }
}
