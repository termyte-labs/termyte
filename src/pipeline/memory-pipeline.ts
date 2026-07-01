import type { Store } from "../storage/store.js";
import { DocumentStore } from "../storage/documents.js";
import type { Trace, Observation, ObservationType, Memory, MemoryType } from "../core/types.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import type { LLMProvider, ChatOptions } from "../observer/provider.js";
import { parseAgentXml } from "../observer/parser.js";
import {
  buildConsolidationPrompt,
  buildConsolidationSystemPrompt,
  buildObservationPrompt,
  buildSystemPrompt,
} from "../observer/prompts.js";
import { JobQueue, type Job } from "./job-queue.js";
import { PermanentJobError, RetryableJobError } from "./errors.js";

export interface MemoryPipelineConfig {
  store: Store;
  llm: LLMProvider;
  embeddings?: EmbeddingsProvider;
  chatOptions?: ChatOptions;
}

export interface RunUntilIdleOptions {
  maxJobs?: number;
}

export class MemoryPipeline {
  private readonly store: Store;
  private readonly queue: JobQueue;
  private readonly documents: DocumentStore;
  private readonly llm: LLMProvider;
  private readonly embeddings?: EmbeddingsProvider;
  private readonly chatOptions?: ChatOptions;

  constructor(config: MemoryPipelineConfig) {
    this.store = config.store;
    this.queue = new JobQueue(config.store.getDB());
    this.documents = new DocumentStore(config.store.getDB());
    this.llm = config.llm;
    this.embeddings = config.embeddings;
    this.chatOptions = config.chatOptions;
  }

  ingestTrace(traceId: number): void {
    const trace = this.store.getTrace(traceId);
    if (!trace) throw new PermanentJobError(`Trace not found: ${traceId}`);

    this.store.transaction(() => {
      this.store.updateTracePipelineState(traceId, "observation_pending");
      this.queue.enqueueJob({
        kind: "extract_observation",
        subjectType: "trace",
        subjectId: traceId,
      });
    });
  }

  enqueueUnprocessedTraces(limit = 50): number {
    const traces = this.store.getUnprocessedTraces(limit);
    this.store.transaction(() => {
      for (const trace of traces) {
        this.store.updateTracePipelineState(trace.id, "observation_pending");
        this.queue.enqueueJob({
          kind: "extract_observation",
          subjectType: "trace",
          subjectId: trace.id,
        });
      }
    });
    return traces.length;
  }

  async runOnce(workerId: string): Promise<boolean> {
    const job = this.queue.claimNextJob(workerId);
    if (!job) return false;

    try {
      switch (job.kind) {
        case "extract_observation":
          await this.extractObservation(job);
          break;
        case "embed_observation":
          await this.embedObservation(job);
          break;
        case "consolidate_memory":
          await this.consolidateMemory(job);
          break;
        case "embed_memory":
          await this.embedMemory(job);
          break;
        case "dedupe_memories":
        case "update_summary":
          // Owned by later modules. These jobs are intentionally durable no-ops
          // here so the pipeline can reach idle without a missing handler.
          break;
      }

      this.queue.markSucceeded(job.id);
      return true;
    } catch (error) {
      this.markSubjectFailed(job, error);
      this.queue.markFailed(job, error);
      return true;
    }
  }

  async runUntilIdle(workerId: string, options: RunUntilIdleOptions = {}): Promise<number> {
    const maxJobs = options.maxJobs ?? Number.POSITIVE_INFINITY;
    let processed = 0;

    while (processed < maxJobs) {
      const ran = await this.runOnce(workerId);
      if (!ran) break;
      processed++;
    }

    return processed;
  }

  getQueueStats() {
    return this.queue.getQueueStats();
  }

  private async extractObservation(job: Job): Promise<void> {
    const trace = this.store.getTrace(Number(job.subjectId));
    if (!trace) throw new PermanentJobError(`Trace not found: ${job.subjectId}`);

    const response = await this.llm.chat(
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildObservationPrompt(traceForPrompt(trace)) },
      ],
      this.chatOptions,
    );
    const parsed = parseAgentXml(response.content);

    if (!parsed.valid) {
      throw new PermanentJobError(`Invalid observation XML for trace ${trace.id}`);
    }

    if (parsed.observations.length === 0) {
      this.store.transaction(() => {
        this.store.markTraceProcessed(trace.id);
      });
      return;
    }

    const session = this.store.getSession(trace.session_id);
    const repo_id = session?.repo_id ?? "unknown";
    const workspace_root = session?.workspace_root ?? "";

    this.store.transaction(() => {
      this.store.updateTracePipelineState(trace.id, "observation_pending");

      for (const parsedObs of parsed.observations) {
        const observation = this.store.insertObservation({
          session_id: trace.session_id,
          repo_id,
          workspace_root,
          type: parsedObs.type as ObservationType,
          title: parsedObs.title,
          description: parsedObs.description,
          files_read: parsedObs.files_read,
          files_modified: parsedObs.files_modified,
          commands_executed: commandFromTrace(trace),
          source_trace_ids: [trace.id],
          created_at: Date.now(),
          processed_at: null,
        });
        this.store.updateObservationLifecycleState(observation.id, "awaiting_embedding");
        this.queue.enqueueJob({
          kind: "embed_observation",
          subjectType: "observation",
          subjectId: observation.id,
        });
      }
    });
  }

  private async embedObservation(job: Job): Promise<void> {
    const observation = this.store.getObservation(Number(job.subjectId));
    if (!observation) throw new PermanentJobError(`Observation not found: ${job.subjectId}`);
    if (observation.lifecycle_state === "indexed") return;

    const content = artifactText(observation.title, observation.description);
    const vector = await this.embedIfConfigured(content);

    this.store.transaction(() => {
      if (vector) this.store.updateObservationEmbedding(observation.id, vector);
      this.documents.upsertDocument({
        id: `observation:${observation.id}`,
        doc_type: "observation",
        source_id: String(observation.id),
        session_id: observation.session_id,
        content,
        files: [...observation.files_read, ...observation.files_modified],
        tags: [observation.type],
        importance: 0.45,
        confidence: 0.65,
        recency_ts: observation.created_at,
        created_at: observation.created_at,
      });
      this.store.updateObservationLifecycleState(observation.id, "indexed");

      for (const traceId of observation.source_trace_ids) {
        this.store.updateTracePipelineState(traceId, "observation_ready");
      }

      this.queue.enqueueJob({
        kind: "consolidate_memory",
        subjectType: "observation",
        subjectId: observation.id,
      });
    });
  }

  private async consolidateMemory(job: Job): Promise<void> {
    const observation = this.store.getObservation(Number(job.subjectId));
    if (!observation) throw new PermanentJobError(`Observation not found: ${job.subjectId}`);
    if (observation.lifecycle_state !== "indexed") {
      throw new RetryableJobError(`Observation ${observation.id} is not indexed`);
    }

    const response = await this.llm.chat(
      [
        { role: "system", content: buildConsolidationSystemPrompt() },
        {
          role: "user",
          content: buildConsolidationPrompt([{
            id: observation.id,
            title: observation.title,
            description: observation.description,
            type: observation.type,
            files_read: observation.files_read,
            files_modified: observation.files_modified,
          }]),
        },
      ],
      this.chatOptions,
    );
    const parsed = parseAgentXml(response.content);

    if (!parsed.valid) {
      throw new PermanentJobError(`Invalid consolidation XML for observation ${observation.id}`);
    }

    if (parsed.observations.length === 0) {
      this.store.transaction(() => {
        this.store.markObservationProcessed(observation.id);
        for (const traceId of observation.source_trace_ids) this.store.markTraceProcessed(traceId);
      });
      return;
    }

    const session = this.store.getSession(observation.session_id);
    const repo_id = session?.repo_id ?? observation.repo_id;
    const workspace_root = session?.workspace_root ?? observation.workspace_root;

    this.store.transaction(() => {
      this.store.updateObservationLifecycleState(observation.id, "indexed");

      for (const traceId of observation.source_trace_ids) {
        this.store.updateTracePipelineState(traceId, "memory_pending");
      }

      for (const parsedMemory of parsed.observations) {
        const memory = this.store.insertMemory({
          session_id: observation.session_id,
          repo_id,
          workspace_root,
          type: parsedMemory.type as MemoryType,
          title: parsedMemory.title,
          description: parsedMemory.description,
          files_read: unique([...observation.files_read, ...parsedMemory.files_read]),
          files_modified: unique([...observation.files_modified, ...parsedMemory.files_modified]),
          source_observation_ids: [observation.id],
          source_trace_ids: observation.source_trace_ids,
          created_at: Date.now(),
          embedding: null,
        });
        this.store.updateMemoryLifecycleState(memory.id, "awaiting_embedding");
        this.queue.enqueueJob({
          kind: "embed_memory",
          subjectType: "memory",
          subjectId: memory.id,
        });
      }
    });
  }

  private async embedMemory(job: Job): Promise<void> {
    const memory = this.store.getMemory(Number(job.subjectId));
    if (!memory) throw new PermanentJobError(`Memory not found: ${job.subjectId}`);
    if (memory.lifecycle_state === "active") return;

    const content = artifactText(memory.title, memory.description);
    const vector = await this.embedIfConfigured(content);

    this.store.transaction(() => {
      if (vector) this.store.updateMemoryEmbedding(memory.id, vector);
      this.documents.upsertDocument({
        id: `memory:${memory.id}`,
        doc_type: "memory",
        source_id: String(memory.id),
        session_id: memory.session_id,
        content,
        files: [...memory.files_read, ...memory.files_modified],
        tags: [memory.type, "active"],
        importance: memory.importance ?? 0.5,
        confidence: memory.confidence ?? 0.5,
        recency_ts: memory.created_at,
        created_at: memory.created_at,
      });
      this.store.updateMemoryLifecycleState(memory.id, "active");

      for (const observationId of memory.source_observation_ids) {
        this.store.markObservationProcessed(observationId);
      }
      for (const traceId of memory.source_trace_ids) {
        this.store.markTraceProcessed(traceId);
      }

      this.queue.enqueueJob({
        kind: "dedupe_memories",
        subjectType: "memory",
        subjectId: memory.id,
      });
      this.queue.enqueueJob({
        kind: "update_summary",
        subjectType: "summary",
        subjectId: memory.session_id,
      });
    });
  }

  private async embedIfConfigured(content: string): Promise<Float32Array | null> {
    if (!this.embeddings) return null;
    try {
      return await this.embeddings.embed(content);
    } catch (error) {
      throw new RetryableJobError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  private markSubjectFailed(job: Job, error: unknown): void {
    if (!(error instanceof PermanentJobError)) return;
    const subjectId = Number(job.subjectId);
    if (!Number.isFinite(subjectId)) return;

    this.store.transaction(() => {
      if (job.subjectType === "trace") this.store.markTraceFailed(subjectId);
      if (job.subjectType === "observation") this.store.markObservationFailed(subjectId);
      if (job.subjectType === "memory") this.store.markMemoryFailed(subjectId);
    });
  }
}

function traceForPrompt(trace: Trace) {
  return {
    tool_name: trace.tool_name ?? "",
    tool_input: trace.tool_input,
    tool_output: trace.tool_output,
    timestamp: trace.timestamp,
  };
}

function commandFromTrace(trace: Trace): string[] {
  if (trace.tool_name !== "Bash") return [];
  if (!trace.tool_input || typeof trace.tool_input !== "object") return [];
  const command = (trace.tool_input as { command?: unknown }).command;
  return typeof command === "string" && command ? [command] : [];
}

function artifactText(title: string, description: string | null): string {
  return [title, description].filter(Boolean).join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
