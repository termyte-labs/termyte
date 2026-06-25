import type { Store } from "../storage/store.js";
import type { Trace, Memory, Summary, MemoryType } from "../core/types.js";
import { parseAgentXml, type ParsedObservation, type ParsedSummary } from "./parser.js";
import {
  buildObservationPrompt,
  buildSummaryPrompt,
  buildSystemPrompt,
  type TraceForPrompt,
  type SummaryForPrompt,
} from "./prompts.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import type { LLMProvider, ChatOptions } from "./provider.js";

export interface ObserverConfig {
  store: Store;
  llm: LLMProvider;
  embeddings?: EmbeddingsProvider;
  /** How many tool traces to bundle into one observer prompt. */
  batchSize?: number;
  /** Extra options passed to the LLM call. */
  chatOptions?: ChatOptions;
}

/**
 * The observer. Reads traces, calls the LLM, parses XML, writes memories.
 *
 * Run modes:
 *
 *   - in-process: the same Node process that runs the hook also runs the
 *     observer. Call `enqueue` from the hook, then `flush` before the hook
 *     exits. The hook binary in `src/cli/hook.ts` does this.
 *
 *   - standalone worker: a separate process runs `Observer.run` in a loop
 *     against unprocessed traces. See `src/cli/worker.ts`.
 *
 * Both modes use the same `processed_at` column on `traces` to be
 * crash-safe: if the process dies mid-batch, the next run picks up the
 * unconsumed traces.
 */
export class Observer {
  private store: Store;
  private llm: LLMProvider;
  private embeddings?: EmbeddingsProvider;
  private batchSize: number;
  private chatOptions?: ChatOptions;
  private inFlight: Promise<void> = Promise.resolve();
  private queue: Trace[] = [];
  private scheduled = false;

  constructor(config: ObserverConfig) {
    this.store = config.store;
    this.llm = config.llm;
    this.embeddings = config.embeddings;
    this.batchSize = config.batchSize ?? 5;
    this.chatOptions = config.chatOptions;
  }

  /** Add a trace to the in-process observer's queue. */
  enqueue(trace: Trace): void {
    this.queue.push(trace);
    this.schedule();
  }

  /** Add many traces at once. */
  enqueueMany(traces: Trace[]): void {
    for (const t of traces) this.queue.push(t);
    this.schedule();
  }

  /** Wait until the queue is fully drained. */
  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      await this.inFlight;
    }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.inFlight = this.drainOnce().catch((err) => {
        // Swallow: the store is the source of truth, traces are still
        // unprocessed and the next pass will retry.
        // eslint-disable-next-line no-console
        console.error("observer error:", err instanceof Error ? err.message : String(err));
      });
    });
  }

  private async drainOnce(): Promise<void> {
    if (this.queue.length === 0) return;
    const trace = this.queue.shift()!;
    await this.processOne(trace);
    if (this.queue.length > 0) {
      // Continue draining in the same tick.
      await this.drainOnce();
    }
  }

  /** Process a single trace: send to LLM, parse, persist. */
  async processOne(trace: Trace): Promise<void> {
    const prompt: TraceForPrompt = {
      tool_name: trace.tool_name ?? "",
      tool_input: trace.tool_input,
      tool_output: trace.tool_output,
      timestamp: trace.timestamp,
    };
    const userContent = buildObservationPrompt(prompt);
    const response = await this.llm.chat(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: userContent },
      ],
      this.chatOptions,
    );

    const parsed = parseAgentXml(response.content);
    if (!parsed.valid) {
      this.store.markTraceProcessed(trace.id);
      return;
    }

    if (parsed.summary && parsed.summary.skipped) {
      this.store.markTraceProcessed(trace.id);
      return;
    }

    if (parsed.observations.length > 0) {
      for (const obs of parsed.observations) {
        this.persistObservation(trace.session_id, obs);
      }
    }

    if (parsed.summary) {
      this.persistSummary(trace.session_id, parsed.summary);
    }

    this.store.markTraceProcessed(trace.id);
  }

  private persistObservation(session_id: string, obs: ParsedObservation): Memory {
    const memory: Omit<Memory, "id"> = {
      session_id,
      type: obs.type as MemoryType,
      title: obs.title ?? "(untitled)",
      subtitle: obs.subtitle,
      facts: obs.facts,
      narrative: obs.narrative,
      concepts: obs.concepts,
      files_read: obs.files_read,
      files_modified: obs.files_modified,
      created_at: Date.now(),
      embedding: null,
    };
    const inserted = this.store.insertMemory(memory);

    if (this.embeddings) {
      const text = memoryToText(inserted);
      // Fire and forget; embedding failures don't fail the observation.
      this.embeddings
        .embed(text)
        .then((vec) => this.store.updateMemoryEmbedding(inserted.id, vec))
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error("embedding error:", err instanceof Error ? err.message : String(err));
        });
    }

    return inserted;
  }

  private persistSummary(session_id: string, summary: ParsedSummary): Summary {
    const s: Omit<Summary, "id"> = {
      session_id,
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      notes: summary.notes,
      created_at: Date.now(),
    };
    return this.store.upsertSummary(s);
  }

  /**
   * Standalone-worker entry. Process up to `limit` unprocessed traces from
   * the store, oldest first, in batches of `batchSize`. Returns the number of
   * traces consumed.
   */
  async processUnprocessedOnce(limit = 50): Promise<number> {
    const traces = this.store.getUnprocessedTraces(limit);
    if (traces.length === 0) return 0;

    for (let i = 0; i < traces.length; i += this.batchSize) {
      const batch = traces.slice(i, i + this.batchSize);
      for (const t of batch) {
        try {
          await this.processOne(t);
        } catch (err) {
          // Leave the trace unprocessed so the next run retries.
          // eslint-disable-next-line no-console
          console.error("trace processing failed:", err instanceof Error ? err.message : String(err));
        }
      }
    }
    return traces.length;
  }

  /** Convenience: build the summary prompt and persist. Used by the worker. */
  async generateSummary(input: SummaryForPrompt, session_id: string): Promise<void> {
    const response = await this.llm.chat(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildSummaryPrompt(input) },
      ],
      this.chatOptions,
    );
    const parsed = parseAgentXml(response.content);
    if (!parsed.valid || !parsed.summary || parsed.summary.skipped) return;
    this.persistSummary(session_id, parsed.summary);
  }
}

function memoryToText(m: Memory): string {
  return [
    m.title,
    m.subtitle ?? "",
    m.narrative ?? "",
    m.facts.join(" "),
    m.concepts.join(" "),
    m.files_read.join(" "),
    m.files_modified.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}
