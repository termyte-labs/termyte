import type { ContextEffectVerdict, Evidence, MemoryFeedbackEvent } from "../shared/types.js";
import type { Store } from "../storage/store.js";

const EXPLICIT_CONFIDENCE = 0.95;
const INFERRED_HELPED_CONFIDENCE = 0.65;
const INFERRED_UNUSED_CONFIDENCE = 0.60;

export function attributeEpisodeContext(store: Store, episodeId: string, nowMs = Date.now()): number {
  const episode = store.getEpisode(episodeId);
  const outcome = store.getCurrentEpisodeOutcome(episodeId);
  if (!episode || !outcome?.context_injection_id) return 0;
  const injection = store.getContextInjection(outcome.context_injection_id);
  if (!injection) return 0;
  const packet = injection.packet_id ? store.getContextPacket(injection.packet_id) : null;
  const evidence = store.getEvidenceForEpisode(episodeId)
    .filter((item) => item.observed_at >= injection.created_at);
  const taskMismatch = packet?.episode_id != null && packet.episode_id !== episodeId;
  let written = 0;

  for (const item of store.getContextInjectionItems(injection.id)) {
    const memory = store.getMemory(item.memory_id);
    if (!memory) continue;
    const candidateId = `${memory.type === "procedure" ? "procedure" : "memory"}:${memory.id}`;
    const feedback = store.getMemoryFeedbackForMemory(memory.id)
      .filter((row) => row.context_injection_id === injection.id && row.source !== "inferred-effect" && row.event_type !== "shown")
      .at(-1);
    const files = new Set([...memory.files_read, ...memory.files_modified].map(normalize));
    const commands = (memory.applicability_evidence?.commands ?? []).map(normalize);
    const fileEvidence = evidence.filter((item) => item.kind === "file" || item.kind === "diff");
    const commandEvidence = evidence.filter((item) => item.kind === "command" || item.kind === "test" || item.kind === "build");
    const fileOverlap = fileEvidence.filter((item) => evidenceFiles(item).some((file) => files.has(normalize(file))));
    const commandOverlap = commandEvidence.filter((item) => commands.some((command) => command === normalize(item.content)));
    const overlapEvidence = [...fileOverlap, ...commandOverlap];
    const successfulExecution = commandEvidence.some((item) => item.exit_code === 0);
    const hasApplicability = files.size > 0 || commands.length > 0;
    const decision = decide({
      feedback: feedback?.event_type,
      succeeded: outcome.status === "succeeded",
      taskMismatch,
      hasApplicability,
      hasOverlap: overlapEvidence.length > 0,
      successfulExecution,
    });
    const signals = {
      source: feedback ? "explicit" : "inferred",
      feedback_event: feedback?.event_type ?? null,
      evidence_ids: evidence.map((item) => item.id),
      overlap_evidence_ids: overlapEvidence.map((item) => item.id),
      task_mismatch: taskMismatch,
      has_applicability: hasApplicability,
      successful_execution: successfulExecution,
      threshold: decision.confidence,
    };
    const effect = store.upsertContextEffect({
      injectionId: injection.id,
      packetId: injection.packet_id,
      episodeId,
      memoryId: memory.id,
      candidateId,
      verdict: decision.verdict,
      confidence: decision.confidence,
      outcomeStatus: outcome.status,
      signals,
      feedbackId: feedback?.id ?? null,
      nowMs,
    });
    written++;

    if (!feedback && decision.verdict === "helped" && decision.confidence >= INFERRED_HELPED_CONFIDENCE) {
      const feedbackId = `effect_feedback:${effect.id}`;
      store.recordMemoryFeedback({
        id: `memory:${memory.id}`,
        event: "helpful",
        contextInjectionId: injection.id,
        source: "inferred-effect",
        feedbackId,
        nowMs,
      });
      store.upsertContextEffect({
        id: effect.id,
        injectionId: injection.id,
        packetId: injection.packet_id,
        episodeId,
        memoryId: memory.id,
        candidateId,
        verdict: decision.verdict,
        confidence: decision.confidence,
        outcomeStatus: outcome.status,
        signals,
        feedbackId,
        nowMs,
      });
    }
  }
  return written;
}

function decide(input: {
  feedback?: MemoryFeedbackEvent;
  succeeded: boolean;
  taskMismatch: boolean;
  hasApplicability: boolean;
  hasOverlap: boolean;
  successfulExecution: boolean;
}): { verdict: ContextEffectVerdict; confidence: number } {
  if (input.feedback === "harmful" || input.feedback === "corrected") {
    return { verdict: "hurt", confidence: EXPLICIT_CONFIDENCE };
  }
  if ((input.feedback === "helpful" || input.feedback === "used") && input.succeeded) {
    return { verdict: "helped", confidence: EXPLICIT_CONFIDENCE };
  }
  if (input.feedback === "ignored" || input.feedback === "downranked") {
    return { verdict: "unused", confidence: EXPLICIT_CONFIDENCE };
  }
  if (input.taskMismatch || !input.hasApplicability) return { verdict: "unknown", confidence: 0.5 };
  if (!input.hasOverlap) return { verdict: "unused", confidence: INFERRED_UNUSED_CONFIDENCE };
  if (input.succeeded && input.successfulExecution) {
    return { verdict: "helped", confidence: INFERRED_HELPED_CONFIDENCE };
  }
  return { verdict: "unknown", confidence: 0.5 };
}

function evidenceFiles(evidence: Evidence): string[] {
  const changed = evidence.metadata["changed_paths"];
  return [
    ...(evidence.kind === "file" ? [evidence.content] : []),
    ...(Array.isArray(changed) ? changed.filter((value): value is string => typeof value === "string") : []),
  ];
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").trim().toLowerCase();
}
