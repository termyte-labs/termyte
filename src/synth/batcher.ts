/**
 * Batcher — reads unprocessed traces from the Store, groups them
 * into batches, hands each batch to an AgentAdapter, then writes the
 * resulting observations and memories back to the Store.
 *
 * Pure orchestration: no agent-specific logic. The adapter decides
 * how to call the model; the batcher decides what to send.
 *
 * Crash-safety: a batch is only marked "synthesized" after the
 * observations are persisted. If the process dies mid-batch, the
 * traces remain unprocessed and the next call picks them up.
 */
import type { Store } from "../storage/store.js";
import type { Trace } from "../core/types.js";
import type { AgentAdapter } from "./types.js";
import { AgentInvocationError } from "./types.js";
import { buildBatchPrompt, SYNTHESIS_SYSTEM_PROMPT, type SynthesisTraceInput } from "./prompts.js";
import { parseAgentXml } from "../observer/parser.js";
import type { ObservationType } from "../core/types.js";
import { JobQueue } from "../pipeline/job-queue.js";

export interface BatcherOptions {
  /** Max traces per invocation. Default 50 (see design report §5.5). */
  batchSize?: number;
  /** Max batches per `runOnce` call. Default 5. */
  maxBatches?: number;
  /** Wall-clock timeout per invocation. */
  perBatchTimeoutMs?: number;
  /** Per-invocation USD cap (adapters that support it will honor it). */
  perBatchBudgetUsd?: number;
  /** Session id filter — if set, only synthesize traces from this session. */
  sessionId?: string;
  /** Repo id filter — if set, only synthesize traces from this repo. */
  repoId?: string;
}

export interface BatcherRunResult {
  batches: number;
  tracesRead: number;
  observationsWritten: number;
  durationMs: number;
  /** Last error from any failed batch, if any. */
  lastError?: { reason: string; message: string };
}

export class Batcher {
  private store: Store;
  private adapter: AgentAdapter;
  private queue: JobQueue;

  constructor(store: Store, adapter: AgentAdapter) {
    this.store = store;
    this.adapter = adapter;
    this.queue = new JobQueue(store.getDB());
  }

  async runOnce(opts: BatcherOptions = {}): Promise<BatcherRunResult> {
    const startedAt = Date.now();
    const batchSize = opts.batchSize ?? 50;
    const maxBatches = opts.maxBatches ?? 5;
    const perBatchTimeoutMs = opts.perBatchTimeoutMs ?? 5 * 60_000;
    const perBatchBudgetUsd = opts.perBatchBudgetUsd;

    let batches = 0;
    let tracesRead = 0;
    let observationsWritten = 0;
    let lastError: BatcherRunResult["lastError"];

    for (let i = 0; i < maxBatches; i++) {
      const traces = this.pickBatch(batchSize, opts);
      if (traces.length === 0) break;
      tracesRead += traces.length;

      try {
        const written = await this.synthesizeOne(traces, {
          timeoutMs: perBatchTimeoutMs,
          maxBudgetUsd: perBatchBudgetUsd,
        });
        observationsWritten += written;
        batches++;
      } catch (err) {
        const info = err instanceof AgentInvocationError
          ? { reason: err.reason, message: err.message }
          : { reason: "internal", message: err instanceof Error ? err.message : String(err) };
        lastError = info;
        // Don't bail — log via lastError and try the next batch. The
        // traces remain unprocessed, so a later run can retry.
        break;
      }
    }

    return { batches, tracesRead, observationsWritten, durationMs: Date.now() - startedAt, lastError };
  }

  private pickBatch(limit: number, opts: BatcherOptions): Trace[] {
    if (opts.sessionId) {
      return this.store.getCapturedTracesForSession(opts.sessionId, limit);
    }
    if (opts.repoId) {
      return this.store.getCapturedTracesByRepo(opts.repoId, limit);
    }
    return this.store.getCapturedTraces(limit);
  }

  private async synthesizeOne(traces: Trace[], callOpts: { timeoutMs?: number; maxBudgetUsd?: number }): Promise<number> {
    const inputs: SynthesisTraceInput[] = traces.map((t) => ({
      id: t.id, tool_name: t.tool_name, tool_input: t.tool_input,
      tool_output: t.tool_output, user_prompt: t.user_prompt, timestamp: t.timestamp,
    }));
    const prompt = buildBatchPrompt(inputs);
    const result = await this.adapter.invoke(prompt, {
      timeoutMs: callOpts.timeoutMs,
      maxBudgetUsd: callOpts.maxBudgetUsd,
    });
    const parsed = parseAgentXml(result.text);
    if (!parsed.valid) return 0;
    if (parsed.observations.length === 0) {
      // Mark traces as processed even on <skip_summary /> so they
      // don't get re-sent next run.
      this.markProcessed(traces);
      return 0;
    }

    const traceIds = traces.map((t) => t.id);
    const session = this.store.getSession(traces[0]!.session_id);
    const repo_id = session?.repo_id ?? "unknown";
    const workspace_root = session?.workspace_root ?? "";

    let written = 0;
    this.store.transaction(() => {
      for (const trace of traces) {
        this.store.updateTracePipelineState(trace.id, "observation_pending");
      }
      for (const obs of parsed.observations) {
        const inserted = this.store.insertObservation({
          session_id: traces[0]!.session_id,
          repo_id,
          workspace_root,
          type: obs.type as ObservationType,
          title: obs.title,
          description: obs.description,
          files_read: obs.files_read,
          files_modified: obs.files_modified,
          commands_executed: [],
          source_trace_ids: traceIds,
          created_at: Date.now(),
          processed_at: null,
        });
        this.store.updateObservationLifecycleState(inserted.id, "awaiting_embedding");
        this.queue.enqueueJob({
          kind: "embed_observation",
          subjectType: "observation",
          subjectId: inserted.id,
        });
        written++;
      }
    });
    return written;
  }

  private markProcessed(traces: Trace[]): void {
    this.store.markTracesProcessed(traces.map((t) => t.id));
  }
}

export { SYNTHESIS_SYSTEM_PROMPT };
