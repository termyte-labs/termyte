import type { Store } from "../storage/store.js";
import type { Trace, Observation, Memory, Summary, MemoryType, ObservationType } from "../core/types.js";
import { parseAgentXml, type ParsedObservation, type ParsedSummary } from "./parser.js";
import {
  buildObservationPrompt, buildConsolidationPrompt,
  buildSummaryPrompt, buildSystemPrompt, buildConsolidationSystemPrompt,
  type TraceForPrompt, type SessionForPrompt,
} from "./prompts.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import type { LLMProvider, ChatOptions } from "./provider.js";

export interface ObserverConfig {
  store: Store;
  llm: LLMProvider;
  embeddings?: EmbeddingsProvider;
  batchSize?: number;
  /** How many observations to batch for consolidation. */
  consolidationBatchSize?: number;
  chatOptions?: ChatOptions;
}

/**
 * Two-stage observer:
 *   Stage 1: Traces → Observations (per-tool extraction)
 *   Stage 2: Observations → Memories (cross-observation consolidation)
 *
 * Both stages use the same LLM but different prompts.
 * Embeddings are computed for both observations and memories.
 */
export class Observer {
  private store: Store;
  private llm: LLMProvider;
  private embeddings?: EmbeddingsProvider;
  private batchSize: number;
  private consolidationBatchSize: number;
  private chatOptions?: ChatOptions;
  private inFlight: Promise<void> = Promise.resolve();
  private queue: Trace[] = [];
  private scheduled = false;

  constructor(config: ObserverConfig) {
    this.store = config.store;
    this.llm = config.llm;
    this.embeddings = config.embeddings;
    this.batchSize = config.batchSize ?? 5;
    this.consolidationBatchSize = config.consolidationBatchSize ?? 10;
    this.chatOptions = config.chatOptions;
  }

  /** Add a trace to the in-process observer's queue. */
  enqueue(trace: Trace): void {
    this.queue.push(trace);
    this.schedule();
  }

  enqueueMany(traces: Trace[]): void {
    for (const t of traces) this.queue.push(t);
    this.schedule();
  }

  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      await this.inFlight;
      // Yield to the event loop so scheduled setImmediate callbacks can fire.
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.inFlight = this.drainOnce();
    });
  }

  /** Stop any pending work. Safe to call multiple times. */
  destroy(): void {
    this.queue.length = 0;
    this.scheduled = false;
  }

  private async drainOnce(): Promise<void> {
    while (this.queue.length > 0) {
      const trace = this.queue.shift()!;
      try {
        await this.processTraceToObservation(trace);
      } catch (err) {
        console.error("observer error:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Stage 1: Extract observations from a single trace. */
  async processTraceToObservation(trace: Trace): Promise<Observation[]> {
    const userContent = buildObservationPrompt({
      tool_name: trace.tool_name ?? "",
      tool_input: trace.tool_input,
      tool_output: trace.tool_output,
      timestamp: trace.timestamp,
    });
    const response = await this.llm.chat(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: userContent },
      ],
      this.chatOptions,
    );

    const parsed = parseAgentXml(response.content);
    if (!parsed.valid || parsed.observations.length === 0) {
      this.store.markTraceProcessed(trace.id);
      return [];
    }

    // Get session context for repo info.
    const session = this.store.getSession(trace.session_id);
    const repo_id = session?.repo_id ?? "unknown";
    const workspace_root = session?.workspace_root ?? "";

    const observations: Observation[] = [];
    for (const parsedObs of parsed.observations) {
      const obs = this.store.insertObservation({
        session_id: trace.session_id,
        repo_id,
        workspace_root,
        type: parsedObs.type as ObservationType,
        title: parsedObs.title,
        description: parsedObs.description,
        files_read: parsedObs.files_read,
        files_modified: parsedObs.files_modified,
        commands_executed: trace.tool_name === "Bash" && typeof trace.tool_input === "object"
          ? [(trace.tool_input as any)?.command ?? ""].filter(Boolean)
          : [],
        source_trace_ids: [trace.id],
        created_at: Date.now(),
        processed_at: null,
      });
      observations.push(obs);

      // Fire-and-forget embedding.
      if (this.embeddings) {
        const text = [obs.title, obs.description].filter(Boolean).join("\n");
        this.embeddings.embed(text).then(vec => {
          this.store.updateObservationEmbedding(obs.id, vec);
        }).catch(() => {});
      }
    }

    this.store.markTraceProcessed(trace.id);
    return observations;
  }

  /** Stage 2: Consolidate observations into memories. */
  async consolidateObservations(observations: Observation[]): Promise<Memory[]> {
    if (observations.length === 0) return [];

    const promptInput = observations.map(o => ({
      id: o.id,
      title: o.title,
      description: o.description,
      type: o.type,
      files_read: o.files_read,
      files_modified: o.files_modified,
    }));

    const response = await this.llm.chat(
      [
        { role: "system", content: buildConsolidationSystemPrompt() },
        { role: "user", content: buildConsolidationPrompt(promptInput) },
      ],
      this.chatOptions,
    );

    const parsed = parseAgentXml(response.content);
    if (!parsed.valid || parsed.observations.length === 0) {
      // Mark observations processed even without consolidation.
      this.store.markObservationsProcessed(observations.map(o => o.id));
      return [];
    }

    // Collect all source trace IDs transitively.
    const allTraceIds = new Set<number>();
    const allObsIds = observations.map(o => o.id);
    for (const o of observations) {
      for (const tid of o.source_trace_ids) allTraceIds.add(tid);
    }

    const session = this.store.getSession(observations[0]!.session_id);
    const repo_id = session?.repo_id ?? "unknown";
    const workspace_root = session?.workspace_root ?? "";

    const memories: Memory[] = [];
    for (const parsedObs of parsed.observations) {
      // Merge file lists from all source observations.
      const filesRead = new Set<string>();
      const filesModified = new Set<string>();
      for (const o of observations) {
        for (const f of o.files_read) filesRead.add(f);
        for (const f of o.files_modified) filesModified.add(f);
      }

      const memory = this.store.insertMemory({
        session_id: observations[0]!.session_id,
        repo_id,
        workspace_root,
        type: parsedObs.type as MemoryType,
        title: parsedObs.title,
        description: parsedObs.description,
        files_read: [...filesRead],
        files_modified: [...filesModified],
        source_observation_ids: allObsIds,
        source_trace_ids: [...allTraceIds],
        created_at: Date.now(),
        embedding: null,
      });
      memories.push(memory);

      if (this.embeddings) {
        const text = [memory.title, memory.description].filter(Boolean).join("\n");
        this.embeddings.embed(text).then(vec => {
          this.store.updateMemoryEmbedding(memory.id, vec);
        }).catch(() => {});
      }
    }

    this.store.markObservationsProcessed(observations.map(o => o.id));
    return memories;
  }

  /** Generate a session summary from session context. */
  async generateSummary(
    session_id: string,
    input: SessionForPrompt,
  ): Promise<Summary | null> {
    const response = await this.llm.chat(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildSummaryPrompt(input) },
      ],
      this.chatOptions,
    );
    const parsed = parseAgentXml(response.content);
    if (!parsed.valid || !parsed.summary || parsed.summary.skipped) return null;

    const session = this.store.getSession(session_id);
    const repo_id = session?.repo_id ?? "unknown";
    const workspace_root = session?.workspace_root ?? "";

    return this.store.upsertSummary({
      session_id,
      repo_id,
      workspace_root,
      summary: parsed.summary.summary_text,
      key_changes: parsed.summary.key_changes,
      key_learnings: parsed.summary.key_learnings,
      created_at: Date.now(),
    });
  }

  /**
   * Standalone worker: process unprocessed traces through both stages.
   */
  async processUnprocessedOnce(limit = 50): Promise<number> {
    const traces = this.store.getUnprocessedTraces(limit);
    if (traces.length === 0) return 0;

    // Stage 1: traces → observations
    const allObservations: Observation[] = [];
    for (const t of traces) {
      try {
        const obs = await this.processTraceToObservation(t);
        allObservations.push(...obs);
      } catch {
        this.store.markTraceProcessed(t.id); // Don't retry bad traces.
      }
    }

    // Stage 2: observations → memories (batch consolidation)
    if (allObservations.length > 0) {
      for (let i = 0; i < allObservations.length; i += this.consolidationBatchSize) {
        const batch = allObservations.slice(i, i + this.consolidationBatchSize);
        try {
          await this.consolidateObservations(batch);
        } catch (err) {
          console.error("consolidation error:", err instanceof Error ? err.message : String(err));
          this.store.markObservationsProcessed(batch.map(o => o.id));
        }
      }
    }

    return traces.length;
  }
}
