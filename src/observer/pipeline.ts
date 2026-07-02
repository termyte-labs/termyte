import type { Store } from "../storage/store.js";
import type { Trace, Observation, Memory, Summary } from "../core/types.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import type { LLMProvider, ChatOptions } from "./provider.js";
import { JobQueue } from "../pipeline/job-queue.js";
import { MemoryPipeline } from "../pipeline/memory-pipeline.js";
import type { SessionForPrompt } from "./prompts.js";

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

  /** @deprecated Use MemoryPipeline workers directly. */
  async processTraceToObservation(trace: Trace): Promise<Observation[]> {
    this.enqueue(trace);
    await this.flush();
    return this.store
      .getObservationsForSession(trace.session_id)
      .filter((observation) => observation.source_trace_ids.includes(trace.id));
  }

  /** @deprecated Use durable consolidate_memory jobs directly. */
  async consolidateObservations(observations: Observation[]): Promise<Memory[]> {
    this.store.transaction(() => {
      for (const observation of observations) {
        this.queue.enqueueJob({
          kind: "consolidate_memory",
          subjectType: "observation",
          subjectId: observation.id,
        });
      }
    });
    await this.flush();
    const ids = new Set(observations.map((observation) => observation.id));
    return this.store
      .getRecentMemories(10_000)
      .filter((memory) => memory.source_observation_ids.some((id) => ids.has(id)));
  }

  /** Enqueue summary generation without running an LLM in the caller. */
  async generateSummary(sessionId: string, _input: SessionForPrompt): Promise<Summary | null> {
    this.queue.enqueueJob({
      kind: "update_summary",
      subjectType: "summary",
      subjectId: sessionId,
    });
    return this.store.getSummary(sessionId);
  }

  async processUnprocessedOnce(limit = 50): Promise<number> {
    const enqueued = this.pipeline.enqueueUnprocessedTraces(limit);
    await this.flush();
    return enqueued;
  }
}
