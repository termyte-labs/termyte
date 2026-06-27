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
  /** Aggregated token usage across all batches in this run. */
  usage?: { input?: number; output?: number };
  /** Last error from any failed batch, if any. */
  lastError?: { reason: string; message: string };
}

export class Batcher {
  private store: Store;
  private adapter: AgentAdapter;

  constructor(store: Store, adapter: AgentAdapter) {
    this.store = store;
    this.adapter = adapter;
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
    let totalInput = 0;
    let totalOutput = 0;
    let lastError: BatcherRunResult["lastError"];

    for (let i = 0; i < maxBatches; i++) {
      const traces = this.pickBatch(batchSize, opts);
      if (traces.length === 0) break;
      tracesRead += traces.length;

      try {
        const result = await this.synthesizeOne(traces, {
          timeoutMs: perBatchTimeoutMs,
          maxBudgetUsd: perBatchBudgetUsd,
        });
        observationsWritten += result.written;
        if (result.usage?.input) totalInput += result.usage.input;
        if (result.usage?.output) totalOutput += result.usage.output;
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

    const usage = (totalInput > 0 || totalOutput > 0) ? { input: totalInput, output: totalOutput } : undefined;
    return { batches, tracesRead, observationsWritten, durationMs: Date.now() - startedAt, usage, lastError };
  }

  private pickBatch(limit: number, opts: BatcherOptions): Trace[] {
    if (opts.sessionId) {
      return this.store.getUnprocessedTracesForSession(opts.sessionId, limit);
    }
    if (opts.repoId) {
      return this.store.getUnprocessedTracesByRepo(opts.repoId, limit);
    }
    return this.store.getUnprocessedTraces(limit);
  }

  private async synthesizeOne(traces: Trace[], callOpts: { timeoutMs?: number; maxBudgetUsd?: number }): Promise<{ written: number; usage?: { input?: number; output?: number } }> {
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
    if (!parsed.valid) return { written: 0, usage: result.usage };
    if (parsed.observations.length === 0) {
      // Mark traces as processed even on <skip_summary /> so they
      // don't get re-sent next run.
      this.markProcessed(traces);
      return { written: 0, usage: result.usage };
    }

    const traceIds = traces.map((t) => t.id);
    const session = this.store.getSession(traces[0]!.session_id);
    const repo_id = session?.repo_id ?? "unknown";
    const workspace_root = session?.workspace_root ?? "";

    let written = 0;
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
        processed_at: Date.now(),
      });
      written++;
      // Touch the inserted observation so TS doesn't warn.
      void inserted;
    }
    this.markProcessed(traces);
    return { written, usage: result.usage };
  }

  private markProcessed(traces: Trace[]): void {
    this.store.markTracesProcessed(traces.map((t) => t.id));
  }
}

export { SYNTHESIS_SYSTEM_PROMPT };
