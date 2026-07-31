import type { Store } from "../../storage/store.js";
import { DocumentStore } from "../../storage/documents.js";
import type { Trace, Observation, ObservationType, Memory, MemoryType } from "../../shared/types.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import type { LLMProvider, ChatOptions } from "../observations/provider.js";
import { parseAgentXml } from "../observations/parser.js";
import {
  buildConsolidationPrompt,
  buildConsolidationSystemPrompt,
  buildObservationBatchPrompt,
  buildObservationPrompt,
  buildSessionConsolidationPrompt,
  buildSummaryPrompt,
  buildSummarySystemPrompt,
  buildSystemPrompt,
  type SessionForPrompt,
} from "../observations/prompts.js";
import { chatWithRetry } from "../observations/self-correct.js";
import { validateObservation, validateMemory, validateSummary } from "../observations/schemas.js";
import { JobQueue, type Job } from "./job-queue.js";
import { PermanentJobError, RetryableJobError } from "./errors.js";
import {
  canonicalMemoryKey,
  chooseDuplicateWinner,
  shouldDeduplicate,
  type DedupeComparable,
} from "../lifecycle/dedupe.js";
import { memoryDecayScore, nextMemoryStateAfterDecay } from "../lifecycle/decay.js";
import type { CodeApplicabilityEvidence } from "../../shared/types.js";
import { attributeEpisodeContext } from "../../context/attribution.js";

export interface MemoryPipelineConfig {
  store: Store;
  llm: LLMProvider;
  embeddings?: EmbeddingsProvider;
  chatOptions?: ChatOptions;
}

export interface RunUntilIdleOptions {
  maxJobs?: number;
  waitForScheduledMs?: number;
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

  ingestEpisode(episodeId: string, nextRunAt = Date.now()): void {
    if (!this.store.getEpisode(episodeId)) throw new PermanentJobError(`Episode not found: ${episodeId}`);
    this.queue.coalesceJob({
      kind: "synthesize_episode",
      subjectType: "episode",
      subjectId: episodeId,
      nextRunAt,
    });
  }

  enqueueUnprocessedTraces(limit = 50): number {
    const traces = this.store.getCapturedTraces(limit);
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

  enqueueUnprocessedEpisodes(limit = 50): number {
    const episodeIds = this.store.getEpisodeIdsWithCapturedTraces(limit);
    const legacyTraces = this.store.getCapturedTracesWithoutEpisode(limit);
    this.store.transaction(() => {
      for (const episodeId of episodeIds) {
        this.queue.enqueueJob({ kind: "synthesize_episode", subjectType: "episode", subjectId: episodeId });
      }
      for (const trace of legacyTraces) this.ingestTrace(trace.id);
    });
    return episodeIds.length + legacyTraces.length;
  }

  /**
   * Repair queues produced by releases that enqueued prompts and session
   * lifecycle traces for LLM observation extraction. These jobs have no
   * durable tool evidence, so complete them deterministically without model
   * calls. Safe and idempotent across restarts.
   */
  reconcileIneligibleObservationJobs(nowMs = Date.now()): number {
    const db = this.store.getDB();
    return this.store.transaction(() => {
      const eligible = `event_type = 'tool_use' AND tool_name IS NOT NULL AND length(tool_name) > 0`;
      const legacyInternalSession = `EXISTS (
        SELECT 1 FROM traces internal_prompt
        WHERE internal_prompt.session_id = traces.session_id
          AND ltrim(internal_prompt.user_prompt) LIKE '<system>%You are a Termyte observer%'
      )`;
      const jobs = db.prepare(`
        UPDATE jobs
        SET state = 'succeeded', lease_owner = NULL, lease_until = NULL,
            last_error = NULL, updated_at = @nowMs
        WHERE kind = 'extract_observation'
          AND state IN ('pending', 'failed', 'leased')
          AND subject_id IN (
            SELECT CAST(id AS TEXT) FROM traces
            WHERE NOT (${eligible}) OR (${legacyInternalSession})
          )
      `).run({ nowMs });
      db.prepare(`
        UPDATE traces
        SET processed_at = COALESCE(processed_at, @nowMs), pipeline_state = 'complete'
        WHERE (NOT (${eligible}) OR (${legacyInternalSession}))
          AND id IN (
            SELECT CAST(subject_id AS INTEGER) FROM jobs
            WHERE kind = 'extract_observation' AND state = 'succeeded'
          )
      `).run({ nowMs });
      return jobs.changes;
    });
  }

  async runOnce(workerId: string): Promise<boolean> {
    const job = this.queue.claimNextJob(workerId);
    if (!job) return false;

    const heartbeat = setInterval(() => {
      this.queue.renewLease(job.id, workerId, { leaseMs: 60_000 });
    }, 20_000);
    heartbeat.unref?.();

    try {
      switch (job.kind) {
        case "consolidate_session":
          await this.consolidateSession(job.subjectId);
          break;
        case "synthesize_episode":
          await this.synthesizeEpisode(job);
          break;
        case "consolidate_episode":
          await this.consolidateEpisode(job);
          break;
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
          await this.dedupeMemories(job);
          break;
        case "update_summary":
          await this.updateSummary(job);
          break;
        case "decay_memories":
          await this.decayMemories(job);
          break;
        case "verify_memory":
          await this.verifyMemory(job);
          break;
        case "attribute_context":
          attributeEpisodeContext(this.store, job.subjectId);
          break;
        default:
          throw new PermanentJobError(`Unsupported job kind: ${(job as Job).kind}`);
      }

      const completed = this.queue.markSucceeded(job.id, Date.now(), workerId);
      if (completed && job.kind === "synthesize_episode"
        && this.store.getCapturedTracesForEpisode(job.subjectId, 1).length > 0) {
        this.ingestEpisode(job.subjectId, Date.now() + 1_000);
      }
      return true;
    } catch (error) {
      this.markSubjectFailed(job, error);
      this.queue.markFailed(job, error);
      return true;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async runUntilIdle(workerId: string, options: RunUntilIdleOptions = {}): Promise<number> {
    const maxJobs = options.maxJobs ?? Number.POSITIVE_INFINITY;
    const maxWait = options.waitForScheduledMs ?? 0;
    let waited = 0;
    let processed = 0;

    while (processed < maxJobs) {
      const ran = await this.runOnce(workerId);
      if (!ran) {
        // After work begins, wait only for new pending work. Failed retries
        // remain visible for the next worker invocation.
        const nextRunAt = processed > 0
          ? this.queue.getNextPendingRunAt()
          : this.queue.getNextRunAt();
        if (nextRunAt === null) break;
        const remaining = maxWait - waited;
        const delay = Math.max(0, nextRunAt - Date.now());
        if (remaining <= 0 || delay > remaining) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        waited += delay;
        continue;
      }
      processed++;
    }

    return processed;
  }

  getQueueStats() {
    return this.queue.getQueueStats();
  }

  private async synthesizeEpisode(job: Job): Promise<void> {
    const episode = this.store.getEpisode(job.subjectId);
    if (!episode) throw new PermanentJobError(`Episode not found: ${job.subjectId}`);
    const captured = this.store.getCapturedTracesForEpisode(episode.id);
    const traces = captured.filter(isObservationEligibleTrace);
    const ineligible = captured.filter((trace) => !isObservationEligibleTrace(trace));
    if (ineligible.length > 0) this.store.markTracesProcessed(ineligible.map((trace) => trace.id));
    if (traces.length === 0) return;

    const response = await chatWithRetry(
      this.llm,
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildObservationBatchPrompt(traces.map(traceForPrompt)) },
      ],
      this.chatOptions,
      (content) => {
        const parsed = parseAgentXml(content);
        return parsed.valid && parsed.observations.every((observation) => validateObservation(observation));
      },
    );
    const parsed = parseAgentXml(response.content);
    if (!parsed.valid) throw new PermanentJobError(`Invalid observation XML for episode ${episode.id}`);

    if (parsed.observations.length === 0) {
      this.store.markTracesProcessed(traces.map((trace) => trace.id));
      return;
    }

    const traceIds = traces.map((trace) => trace.id);
    const commands = unique(traces.flatMap(commandFromTrace));
    this.store.transaction(() => {
      for (const traceId of traceIds) this.store.updateTracePipelineState(traceId, "observation_pending");
      for (const parsedObservation of parsed.observations) {
        const observation = this.store.insertObservation({
          session_id: episode.session_id,
          repo_id: episode.repo_id,
          workspace_root: episode.workspace_root,
          type: parsedObservation.type as ObservationType,
          title: parsedObservation.title,
          description: parsedObservation.description,
          files_read: parsedObservation.files_read,
          files_modified: parsedObservation.files_modified,
          commands_executed: commands,
          source_trace_ids: traceIds,
          created_at: Date.now(),
          processed_at: null,
        });
        this.store.updateObservationLifecycleState(observation.id, "awaiting_embedding");
        this.store.insertTraceObservationLinks(observation.id, traceIds);
        this.queue.enqueueJob({ kind: "embed_observation", subjectType: "observation", subjectId: observation.id });
      }
    });
  }

  async consolidateSession(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new PermanentJobError(`Session not found: ${sessionId}`);
    const traces = this.store.getAllTracesForSession(sessionId);
    if (traces.length === 0) return;
    const repoId = session.repo_id ?? "unknown";
    const taskRows = this.store.getDB().prepare(`SELECT * FROM tasks WHERE repo_id = ? ORDER BY updated_at DESC`).all(repoId) as Record<string, unknown>[];
    const response = await chatWithRetry(
      this.llm,
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildSessionConsolidationPrompt({ sessionId, repoId, task: taskRows, traces }) },
      ],
      this.chatOptions,
      (content) => {
        const parsed = parseAgentXml(content);
        return parsed.valid && parsed.observations.length <= 1 && parsed.observations.every((observation) => validateObservation(observation));
      },
    );
    const parsed = parseAgentXml(response.content);
    if (!parsed.valid) throw new PermanentJobError(`Invalid session observation XML for ${sessionId}`);
    const eligible = traces.filter(isObservationEligibleTrace);
    if (parsed.observations.length === 0) {
      this.store.markTracesProcessed(eligible.map((trace) => trace.id));
      return;
    }
    const traceIds = eligible.map((trace) => trace.id);
    const commands = unique(eligible.flatMap(commandFromTrace));
    this.store.transaction(() => {
      const parsedObservation = parsed.observations[0];
      if (parsedObservation) {
        const observation = this.store.insertObservation({
          session_id: sessionId,
          repo_id: repoId,
          workspace_root: session.workspace_root ?? "",
          type: parsedObservation.type as ObservationType,
          title: parsedObservation.title,
          description: parsedObservation.description,
          files_read: parsedObservation.files_read,
          files_modified: parsedObservation.files_modified,
          commands_executed: commands,
          source_trace_ids: traceIds,
          created_at: Date.now(),
          processed_at: null,
        });
        this.store.updateObservationLifecycleState(observation.id, "awaiting_embedding");
        this.store.insertTraceObservationLinks(observation.id, traceIds);
        this.queue.enqueueJob({ kind: "embed_observation", subjectType: "observation", subjectId: observation.id });
      }
      for (const traceId of traceIds) this.store.updateTracePipelineState(traceId, "observation_pending");
    });
  }

  private async extractObservation(job: Job): Promise<void> {
    const trace = this.store.getTrace(Number(job.subjectId));
    if (!trace) throw new PermanentJobError(`Trace not found: ${job.subjectId}`);
    // Compatibility guard for queues created by older releases, which
    // enqueued prompts and session lifecycle events as observer work.
    if (!isObservationEligibleTrace(trace)) {
      this.store.markTraceProcessed(trace.id);
      return;
    }

    const response = await chatWithRetry(
      this.llm,
      [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildObservationPrompt(traceForPrompt(trace)) },
      ],
      this.chatOptions,
      (content) => {
        const parsed = parseAgentXml(content);
        if (!parsed.valid) return false;
        if (parsed.observations.length === 0) return true;
        return parsed.observations.every((o) => validateObservation(o));
      },
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
        this.store.insertTraceObservationLinks(observation.id, observation.source_trace_ids);
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
    const vector = await this.embedOptional(content);

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

      const episodeId = observation.source_trace_ids.length > 0
        ? this.store.getEpisodeIdForTrace(observation.source_trace_ids[0]!)
        : null;
      if (episodeId) {
        this.queue.coalesceJob({
          kind: "consolidate_episode",
          subjectType: "episode",
          subjectId: episodeId,
        });
      } else {
        this.queue.enqueueJob({
          kind: "consolidate_memory",
          subjectType: "observation",
          subjectId: observation.id,
        });
      }
    });
  }

  private async consolidateEpisode(job: Job): Promise<void> {
    const episode = this.store.getEpisode(job.subjectId);
    if (!episode) throw new PermanentJobError(`Episode not found: ${job.subjectId}`);
    const observations = this.store.getObservationsForEpisode(episode.id);
    if (observations.length === 0) return;
    if (observations.some((observation) => observation.lifecycle_state !== "indexed")) {
      throw new RetryableJobError(`Episode ${episode.id} has observations awaiting indexing`);
    }
    await this.consolidateObservations(observations, `episode ${episode.id}`, episode.id);
  }

  private async consolidateMemory(job: Job): Promise<void> {
    const observation = this.store.getObservation(Number(job.subjectId));
    if (!observation) throw new PermanentJobError(`Observation not found: ${job.subjectId}`);
    if (observation.lifecycle_state !== "indexed") {
      throw new RetryableJobError(`Observation ${observation.id} is not indexed`);
    }
    await this.consolidateObservations([observation], `observation ${observation.id}`);
  }

  private async consolidateObservations(observations: Observation[], label: string, episodeId?: string): Promise<void> {
    const response = await chatWithRetry(
      this.llm,
      [
        { role: "system", content: buildConsolidationSystemPrompt() },
        { role: "user", content: buildConsolidationPrompt(observations) },
      ],
      this.chatOptions,
      (content) => {
        const parsed = parseAgentXml(content);
        return parsed.valid && parsed.observations.every((memory) => validateMemory(memory));
      },
    );
    const parsed = parseAgentXml(response.content);
    if (!parsed.valid) throw new PermanentJobError(`Invalid consolidation XML for ${label}`);

    const traceIds = uniqueNumbers(observations.flatMap((observation) => observation.source_trace_ids));
    if (parsed.observations.length === 0) {
      this.store.transaction(() => {
        for (const observation of observations) this.store.markObservationProcessed(observation.id);
        for (const traceId of traceIds) this.store.markTraceProcessedIfObservationsReady(traceId);
      });
      return;
    }

    const first = observations[0]!;
    const session = this.store.getSession(first.session_id);
    const filesRead = unique(observations.flatMap((observation) => observation.files_read));
    const filesModified = unique(observations.flatMap((observation) => observation.files_modified));
    const commands = unique(observations.flatMap((observation) => observation.commands_executed));
    const observationIds = observations.map((observation) => observation.id);
    const evidenceIds = episodeId
      ? this.store.getEvidenceForEpisodeSupportingTraces(episodeId, traceIds).map((evidence) => evidence.id)
      : [];

    this.store.transaction(() => {
      for (const traceId of traceIds) this.store.updateTracePipelineState(traceId, "memory_pending");
      for (const parsedMemory of parsed.observations) {
        const memory = this.store.insertMemory({
          session_id: first.session_id,
          repo_id: session?.repo_id ?? first.repo_id,
          workspace_root: session?.workspace_root ?? first.workspace_root,
          type: parsedMemory.type as MemoryType,
          title: parsedMemory.title,
          description: parsedMemory.description,
          files_read: unique([...filesRead, ...parsedMemory.files_read]),
          files_modified: unique([...filesModified, ...parsedMemory.files_modified]),
          source_observation_ids: observationIds,
          source_trace_ids: traceIds,
          created_at: Date.now(),
          embedding: null,
          applicability_evidence: buildApplicabilityEvidence({
            filesRead,
            filesModified,
            commandsExecuted: commands,
            observationIds,
            traceIds,
          }),
        });
        this.store.updateMemoryLifecycleState(memory.id, "awaiting_embedding");
        this.store.insertObservationMemoryLinks(memory.id, observationIds);
        this.store.linkMemoryEvidence(memory.id, evidenceIds);
        this.queue.enqueueJob({ kind: "embed_memory", subjectType: "memory", subjectId: memory.id });
      }
    });
  }

  private async embedMemory(job: Job): Promise<void> {
    const memory = this.store.getMemory(Number(job.subjectId));
    if (!memory) throw new PermanentJobError(`Memory not found: ${job.subjectId}`);
    if (memory.lifecycle_state === "active") return;

    const content = artifactText(memory.title, memory.description);
    const vector = await this.embedOptional(content);

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
        this.store.markObservationProcessedIfMemoriesReady(observationId);
      }
      for (const traceId of memory.source_trace_ids) {
        this.store.markTraceProcessedIfObservationsReady(traceId);
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
        dedupeKey: `trace:${Math.max(0, ...memory.source_trace_ids)}`,
      });
      this.queue.enqueueJob({
        kind: "decay_memories",
        subjectType: "memory",
        subjectId: memory.repo_id || "global",
        dedupeKey: new Date().toISOString().slice(0, 10),
      });
    });
  }

  /**
   * Deduplicate a freshly active memory against same-repo candidates.
   * Computes the canonical key, finds equivalent active memories, chooses a
   * winner, marks the loser superseded with a relationship edge, and removes
   * the loser's search document. Idempotent: superseded subjects short-circuit
   * and edges are uniquely constrained.
   */
  private async dedupeMemories(job: Job): Promise<void> {
    const memoryId = Number(job.subjectId);
    const memory = this.store.getMemory(memoryId);
    if (!memory) throw new PermanentJobError(`Memory not found: ${job.subjectId}`);
    if (memory.lifecycle_state === "superseded" || memory.lifecycle_state === "deleted") return;

    if (!memory.canonical_key) {
      const key = canonicalMemoryKey({
        type: memory.type,
        content: artifactText(memory.title, memory.description),
        files: [...memory.files_read, ...memory.files_modified],
      });
      this.store.updateMemoryCanonicalKey(memory.id, key);
      memory.canonical_key = key;
    }

    const session = this.store.getSession(memory.session_id);
    const repoId = session?.repo_id ?? memory.repo_id;
    const candidates = this.store
      .getAllMemoriesWithEmbeddings(repoId)
      .filter((m) => m.id !== memory.id && (m.lifecycle_state ?? "active") === "active");

    for (const candidate of candidates) {
      if (!candidate.canonical_key) {
        const key = canonicalMemoryKey({
          type: candidate.type,
          content: artifactText(candidate.title, candidate.description),
          files: [...candidate.files_read, ...candidate.files_modified],
        });
        this.store.updateMemoryCanonicalKey(candidate.id, key);
        candidate.canonical_key = key;
      }
      if (!shouldDeduplicate(toComparable(memory), toComparable(candidate))) continue;

      const decision = chooseDuplicateWinner({
        existing: {
          id: candidate.id,
          confidence: candidate.confidence ?? 0.5,
          importance: candidate.importance ?? 0.5,
          created_at: candidate.created_at,
        },
        incoming: {
          id: memory.id,
          confidence: memory.confidence ?? 0.5,
          importance: memory.importance ?? 0.5,
          created_at: memory.created_at,
        },
      });
      const winnerId = decision.keep;
      const loserId = decision.supersede;
      this.store.transaction(() => {
        this.store.markMemorySuperseded(loserId, winnerId);
        this.store.insertMemoryEdge({
          source: winnerId,
          target: loserId,
          edgeType: decision.edgeType,
          confidence: 0.95,
        });
        this.documents.softDeleteDocument(`memory:${loserId}`);
      });
    }
  }

  /**
   * Generate (or refresh) the durable summary for a session. Idempotent: the
   * job subject key is unique per session and `upsertSummary` keeps exactly one
   * latest row per session. A `<skip_summary/>` or empty result records no
   * summary and succeeds without fabricating one.
   */
  private async updateSummary(job: Job): Promise<void> {
    const sessionId = String(job.subjectId);
    const session = this.store.getSession(sessionId);
    if (!session) throw new PermanentJobError(`Session not found: ${sessionId}`);

    const traces = this.store.getAllTracesForSession(sessionId);
    if (traces.length === 0) return;

    const files = new Set<string>();
    const userPrompts: string[] = [];
    let finalResponse: string | null = null;
    for (const trace of traces) {
      if (trace.user_prompt) userPrompts.push(trace.user_prompt);
      if (trace.final_response) finalResponse = trace.final_response;
      if (trace.files_modified) for (const f of trace.files_modified) files.add(f);
    }

    const input: SessionForPrompt = {
      user_prompts: userPrompts,
      final_response: finalResponse,
      files_modified: [...files],
    };

    const response = await chatWithRetry(
      this.llm,
      [
        { role: "system", content: buildSummarySystemPrompt() },
        { role: "user", content: buildSummaryPrompt(input) },
      ],
      this.chatOptions,
      (content) => {
        const parsed = parseAgentXml(content);
        if (!parsed.valid) return false;
        if (parsed.summary?.skipped) return true;
        return validateSummary(parsed.summary);
      },
    );
    const parsed = parseAgentXml(response.content);
    if (!parsed.valid) {
      throw new PermanentJobError(`Invalid summary XML for session ${sessionId}`);
    }
    if (parsed.summary?.skipped || !parsed.summary || !parsed.summary.summary_text) {
      // Nothing durable to summarize — succeed without writing a falsehood.
      return;
    }

    const summaryText = parsed.summary.summary_text;
    this.store.upsertSummary({
      session_id: sessionId,
      repo_id: session.repo_id ?? "unknown",
      workspace_root: session.workspace_root ?? "",
      summary: summaryText,
      key_changes: parsed.summary.key_changes,
      key_learnings: parsed.summary.key_learnings,
      created_at: Date.now(),
    });
  }

  /**
   * Sweep active memories, compute their decay score, persist it, and
   * transition low-scoring memories to `stale`. The job subject is the
   * repo_id (or "global" when absent); idempotent on the subject key so
   * only one sweep runs at a time per scope. Idempotent on re-run:
   * already-stale memories are skipped, and superseded/deleted memories
   * are never touched.
   */
  private async decayMemories(job: Job): Promise<void> {
    const repoId = String(job.subjectId) || "global";
    const nowMs = Date.now();

    const memories = repoId === "global"
      ? this.store.getRecentMemories(10_000)
      : this.store.getRecentMemories(10_000, repoId);

    for (const memory of memories) {
      const state = memory.lifecycle_state ?? "active";
      if (state === "superseded" || state === "deleted" || state === "failed") continue;
      if (state === "stale") continue; // already decayed; reinforcement recovers it

      const score = memoryDecayScore(
        {
          id: memory.id,
          type: memory.type,
          state: (memory.state ?? "active") as "active" | "stale" | "superseded" | "conflicted" | "deleted",
          importance: memory.importance ?? 0.5,
          confidence: memory.confidence ?? 0.5,
          usage_count: memory.usage_count ?? 0,
          created_at: memory.created_at,
          updated_at: memory.last_reinforced_at ?? memory.created_at,
          last_accessed_at: memory.last_accessed_at,
        },
        nowMs,
      );

      const newState = nextMemoryStateAfterDecay(
        {
          id: memory.id,
          type: memory.type,
          state: (memory.state ?? "active") as "active" | "stale" | "superseded" | "conflicted" | "deleted",
          importance: memory.importance ?? 0.5,
          confidence: memory.confidence ?? 0.5,
          usage_count: memory.usage_count ?? 0,
          created_at: memory.created_at,
          updated_at: memory.last_reinforced_at ?? memory.created_at,
          last_accessed_at: memory.last_accessed_at,
        },
        score,
      );

      this.store.updateMemoryDecayScore(memory.id, score, nowMs);
      if (newState === "stale" && state === "active") {
        this.store.updateMemoryLifecycleState(memory.id, "stale");
      }
    }
  }

  /**
   * Verify a corrected memory. If correction text was provided, create a
   * grounded replacement memory, embed it, link it with a `supersedes` edge,
   * and mark the old memory superseded. If no correction text was provided,
   * mark the memory `conflicted` so it is excluded from default retrieval but
   * not deleted. Idempotent: already-superseded memories short-circuit.
   */
  private async verifyMemory(job: Job): Promise<void> {
    const memoryId = Number(job.subjectId);
    const memory = this.store.getMemory(memoryId);
    if (!memory) throw new PermanentJobError(`Memory not found: ${job.subjectId}`);
    if (memory.lifecycle_state === "superseded" || memory.lifecycle_state === "deleted") return;

    // Find the latest correction feedback with text.
    const correctionRow = this.store.getDB().prepare(
      `SELECT correction_text, context_injection_id
       FROM memory_feedback
       WHERE memory_id = ? AND event_type = 'corrected' AND correction_text IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    ).get(memoryId) as { correction_text: string | null; context_injection_id: string | null } | undefined;

    const episodeId = correctionRow?.context_injection_id
      ? this.store.getEpisodeIdForContextInjection(correctionRow.context_injection_id)
      : null;
    const correctionEvidence = episodeId && correctionRow?.correction_text
      ? this.store.getEvidenceForEpisode(episodeId)
        .filter((evidence) => evidence.kind === "human_feedback" && evidence.content === correctionRow.correction_text)
        .at(-1) ?? null
      : null;

    if (!correctionRow?.correction_text || !correctionEvidence) {
      // No replacement text — mark conflicted so retrieval excludes it.
      if (memory.lifecycle_state !== "conflicted") {
        this.store.updateMemoryLifecycleState(memoryId, "conflicted");
      }
      return;
    }

    // Create the replacement memory from the correction text.
    const episode = this.store.getEpisode(correctionEvidence.episode_id)!;
    const replacement = this.store.insertMemory({
      session_id: episode.session_id,
      repo_id: episode.repo_id,
      workspace_root: episode.workspace_root,
      type: memory.type,
      title: `Corrected: ${memory.title}`,
      description: correctionRow.correction_text,
      files_read: [],
      files_modified: [],
      source_observation_ids: [],
      source_trace_ids: [],
      created_at: Date.now(),
      embedding: null,
      applicability_evidence: buildApplicabilityEvidence({
        filesRead: [],
        filesModified: [],
        commandsExecuted: [],
        observationIds: [],
        traceIds: [],
      }),
    });
    this.store.updateMemoryLifecycleState(replacement.id, "awaiting_embedding");
    this.store.linkMemoryEvidence(replacement.id, [correctionEvidence.id]);

    // Embed the replacement, then supersede the original.
    const content = artifactText(replacement.title, replacement.description);
    const vector = await this.embedOptional(content);

    this.store.transaction(() => {
      if (vector) this.store.updateMemoryEmbedding(replacement.id, vector);
      this.store.updateMemoryLifecycleState(replacement.id, "active");

      this.documents.upsertDocument({
        id: `memory:${replacement.id}`,
        doc_type: "memory",
        source_id: String(replacement.id),
        session_id: replacement.session_id,
        content,
        files: [...replacement.files_read, ...replacement.files_modified],
        tags: [replacement.type, "active"],
        importance: replacement.importance ?? 0.5,
        confidence: 0.75, // corrected version starts with slightly reduced confidence
        recency_ts: replacement.created_at,
        created_at: replacement.created_at,
      });

      this.store.markMemorySuperseded(memoryId, replacement.id);
      this.store.insertMemoryEdge({
        source: replacement.id,
        target: memoryId,
        edgeType: "supersedes",
        confidence: 0.85,
      });
      this.documents.softDeleteDocument(`memory:${memoryId}`);
    });
  }

  private async embedOptional(content: string): Promise<Float32Array | null> {
    if (!this.embeddings || this.embeddings.dimensions <= 0) return null;
    try {
      return await this.embeddings.embed(content);
    } catch {
      // Embedding failures must not block durable capture or memory
      // consolidation. The document corpus and FTS path remain usable.
      return null;
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

export function isObservationEligibleTrace(trace: Pick<Trace, "event_type" | "tool_name">): boolean {
  return trace.event_type === "tool_use" && typeof trace.tool_name === "string" && trace.tool_name.length > 0;
}

function traceForPrompt(trace: Trace) {
  return {
    id: trace.id,
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

function toComparable(m: Memory): DedupeComparable {
  return {
    id: m.id,
    type: m.type,
    canonical_key: m.canonical_key ?? null,
    files_read: m.files_read,
    files_modified: m.files_modified,
    embedding: m.embedding,
  };
}

function buildApplicabilityEvidence(input: {
  observation?: Observation;
  filesRead?: string[];
  filesModified?: string[];
  commandsExecuted?: string[];
  observationIds?: number[];
  traceIds?: number[];
}): CodeApplicabilityEvidence {
  const observation = input.observation;
  return {
    files: unique([
      ...(input.filesRead ?? []),
      ...(input.filesModified ?? []),
      ...(observation?.files_read ?? []),
      ...(observation?.files_modified ?? []),
    ]),
    commands: unique([
      ...(input.commandsExecuted ?? []),
      ...(observation?.commands_executed ?? []),
    ]),
    trace_ids: uniqueNumbers([
      ...(input.traceIds ?? []),
      ...(observation?.source_trace_ids ?? []),
    ]),
    observation_ids: uniqueNumbers([
      ...(input.observationIds ?? []),
      observation?.id ?? 0,
    ]),
  };
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}
