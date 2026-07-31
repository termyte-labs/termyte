import type { ContextEffect, Evidence, Memory, Observation, Trace } from "../../shared/types.js";
import type { Store } from "../../storage/store.js";

export interface ExplainMemoryEdge {
  id: string;
  direction: "incoming" | "outgoing";
  edge_type: string;
  confidence: number;
  created_at: number;
  source_memory_id: number;
  target_memory_id: number;
  peer_memory: ExplainMemorySummary | null;
}

export interface ExplainMemorySummary {
  id: number;
  title: string;
  type: string;
  state: string | undefined;
  lifecycle_state: string | undefined;
  repo_id: string;
  session_id: string;
}

export interface ExplainObservation extends Observation {
  missing: boolean;
}

export interface ExplainTrace extends Trace {
  missing: boolean;
}

export interface ExplainFeedback {
  id: string;
  memory_id: number;
  doc_id: string | null;
  event_type: string;
  weight: number;
  source: string;
  context_injection_id: string | null;
  correction_text: string | null;
  created_at: number;
}

export interface ExplainMemory {
  id: number;
  document_id: string;
  title: string;
  type: string;
  description: string | null;
  repo_id: string;
  session_id: string;
  workspace_root: string;
  lifecycle_state: string | undefined;
  state: string | undefined;
  importance: number | undefined;
  confidence: number | undefined;
  usage_count: number | undefined;
  last_accessed_at: number | null | undefined;
  last_reinforced_at: number | null | undefined;
  decayed_score: number | undefined;
  content_hash: string | null | undefined;
  canonical_key: string | null | undefined;
  superseded_by: number | null | undefined;
  applicability_evidence: Memory["applicability_evidence"];
  created_at: number;
  files_read: string[];
  files_modified: string[];
  source_observation_ids: number[];
  source_trace_ids: number[];
}

export interface ExplainOutput {
  requested_id: string;
  resolved_id: number | null;
  found: boolean;
  memory: ExplainMemory | null;
  source_observations: ExplainObservation[];
  source_traces: ExplainTrace[];
  source_evidence: Evidence[];
  edges: ExplainMemoryEdge[];
  feedback: ExplainFeedback[];
  context_effects: ContextEffect[];
  missing_source_observation_ids: number[];
  missing_source_trace_ids: number[];
  missing_evidence_ids: string[];
  provenance_valid: boolean;
}

export function buildMemoryExplain(store: Store, requestedId: string): ExplainOutput {
  const resolvedId = resolveMemoryId(store, requestedId);
  if (resolvedId === null) {
    return emptyExplain(requestedId);
  }

  const memory = store.getMemory(resolvedId);
  if (!memory) {
    return emptyExplain(requestedId, resolvedId);
  }

  const sourceObservationIds = uniqueIds(memory.source_observation_ids);
  const sourceObservations = store.getObservationsByIds(sourceObservationIds).map((observation) => ({
    ...observation,
    missing: false,
  }));
  const missingSourceObservationIds = sourceObservationIds.filter((id) => !sourceObservations.some((observation) => observation.id === id));

  const sourceTraceIds = uniqueIds([
    ...memory.source_trace_ids,
    ...sourceObservations.flatMap((observation) => observation.source_trace_ids),
  ]);
  const sourceTraces = store.getTracesByIds(sourceTraceIds).map((trace) => ({
    ...trace,
    missing: false,
  }));
  const missingSourceTraceIds = sourceTraceIds.filter((id) => !sourceTraces.some((trace) => trace.id === id));
  const evidenceLinks = store.getMemoryEvidenceLinks(resolvedId);
  const sourceEvidence = evidenceLinks.flatMap((link) => link.evidence ? [link.evidence] : []);
  const missingEvidenceIds = evidenceLinks.filter((link) => !link.evidence).map((link) => link.evidence_id);

  const edges = store.getMemoryEdges(resolvedId).map((edge) => {
    const outgoing = edge.source_memory_id === resolvedId;
    const peerId = outgoing ? edge.target_memory_id : edge.source_memory_id;
    const peer = store.getMemory(peerId);
    return {
      ...edge,
      direction: outgoing ? "outgoing" as const : "incoming" as const,
      peer_memory: peer ? summarizeMemory(peer) : null,
    };
  });

  const feedback = store.getMemoryFeedbackForMemory(resolvedId).map((row) => ({
    ...row,
  }));
  const contextEffects = store.getContextEffectsForMemory(resolvedId);

  return {
    requested_id: requestedId,
    resolved_id: resolvedId,
    found: true,
    memory: summarizeMemory(memory),
    source_observations: sourceObservations,
    source_traces: sourceTraces,
    source_evidence: sourceEvidence,
    edges,
    feedback,
    context_effects: contextEffects,
    missing_source_observation_ids: missingSourceObservationIds,
    missing_source_trace_ids: missingSourceTraceIds,
    missing_evidence_ids: missingEvidenceIds,
    provenance_valid: missingSourceObservationIds.length === 0
      && missingSourceTraceIds.length === 0
      && missingEvidenceIds.length === 0
      && (sourceObservations.length > 0 || sourceTraces.length > 0 || sourceEvidence.length > 0),
  };
}

export function renderMemoryExplain(output: ExplainOutput): string {
  const lines: string[] = [];
  lines.push(`# Memory Explanation: ${output.requested_id}`);
  if (!output.found || !output.memory) {
    lines.push("");
    lines.push("(no memory found)");
    return lines.join("\n");
  }

  const memory = output.memory;
  lines.push("");
  lines.push(`Resolved: memory:${memory.id}`);
  lines.push(`Title: ${memory.title}`);
  lines.push(`Type: ${memory.type}`);
  lines.push(`State: ${memory.state ?? "(unknown)"}`);
  lines.push(`Lifecycle: ${memory.lifecycle_state ?? "(unknown)"}`);
  lines.push(`Repo: ${memory.repo_id}`);
  lines.push(`Session: ${memory.session_id}`);
  lines.push(`Workspace: ${memory.workspace_root}`);
  lines.push(`Created: ${formatTimestamp(memory.created_at)}`);
  if (memory.description) {
    lines.push("");
    lines.push(memory.description);
  }
  lines.push("");
  lines.push("## Lifecycle Fields");
  lines.push(`Importance: ${formatMaybeNumber(memory.importance)}`);
  lines.push(`Confidence: ${formatMaybeNumber(memory.confidence)}`);
  lines.push(`Usage count: ${formatMaybeNumber(memory.usage_count)}`);
  lines.push(`Decay score: ${formatMaybeNumber(memory.decayed_score)}`);
  lines.push(`Last accessed: ${formatTimestamp(memory.last_accessed_at ?? null)}`);
  lines.push(`Last reinforced: ${formatTimestamp(memory.last_reinforced_at ?? null)}`);
  lines.push(`Canonical key: ${memory.canonical_key ?? "(none)"}`);
  lines.push(`Superseded by: ${memory.superseded_by != null ? `memory:${memory.superseded_by}` : "(none)"}`);

  lines.push("");
  lines.push("## Applicability Evidence");
  if (!memory.applicability_evidence) {
    lines.push("(none)");
  } else {
    const evidence = memory.applicability_evidence;
    lines.push(`Files: ${evidence.files.length > 0 ? evidence.files.join(", ") : "(none)"}`);
    lines.push(`Commands: ${evidence.commands.length > 0 ? evidence.commands.join(", ") : "(none)"}`);
    lines.push(`Source traces: ${evidence.trace_ids.length > 0 ? evidence.trace_ids.map((id) => `trace:${id}`).join(", ") : "(none)"}`);
    lines.push(`Source observations: ${evidence.observation_ids.length > 0 ? evidence.observation_ids.map((id) => `observation:${id}`).join(", ") : "(none)"}`);
  }

  lines.push("");
  lines.push("## Provenance");
  lines.push(`Integrity: ${output.provenance_valid ? "valid" : "broken or missing"}`);
  if (memory.source_observation_ids.length === 0 && output.source_observations.length === 0) {
    lines.push("(no source observations)");
  } else {
    if (memory.source_observation_ids.length > 0) {
      lines.push(`Source observation ids: ${memory.source_observation_ids.map((id) => `observation:${id}`).join(", ")}`);
    }
    for (const observation of output.source_observations) {
      lines.push("");
      lines.push(`### Observation ${observation.missing ? "(missing)" : `#${observation.id}`} [${observation.type}] ${observation.title}`);
      if (!observation.missing) {
        if (observation.description) lines.push(observation.description);
        lines.push(`Session: ${observation.session_id}`);
        lines.push(`Repo: ${observation.repo_id}`);
        lines.push(`Created: ${formatTimestamp(observation.created_at)}`);
        if (observation.files_read.length > 0) lines.push(`Files read: ${observation.files_read.join(", ")}`);
        if (observation.files_modified.length > 0) lines.push(`Files modified: ${observation.files_modified.join(", ")}`);
        if (observation.source_trace_ids.length > 0) {
          lines.push(`Source traces: ${observation.source_trace_ids.map((id) => `trace:${id}`).join(", ")}`);
        }
      }
    }
  }

  if (output.missing_source_observation_ids.length > 0) {
    lines.push("");
    lines.push(`Missing observations (missing): ${output.missing_source_observation_ids.map((id) => `observation:${id}`).join(", ")}`);
  }

  if (output.source_traces.length > 0 || output.missing_source_trace_ids.length > 0) {
    lines.push("");
    lines.push("## Source Traces");
    for (const trace of output.source_traces) {
      lines.push(`### Trace ${trace.missing ? "(missing)" : `#${trace.id}`} [${trace.event_type}]`);
      if (!trace.missing) {
        lines.push(`Session: ${trace.session_id}`);
        lines.push(`Timestamp: ${formatTimestamp(trace.timestamp)}`);
        lines.push(`Processed: ${formatTimestamp(trace.processed_at)}`);
        if (trace.tool_name) lines.push(`Tool: ${trace.tool_name}`);
        if (trace.user_prompt) lines.push(`User prompt: ${trace.user_prompt}`);
        if (trace.final_response) lines.push(`Final response: ${trace.final_response}`);
        if (trace.files_read && trace.files_read.length > 0) lines.push(`Files read: ${trace.files_read.join(", ")}`);
        if (trace.files_modified && trace.files_modified.length > 0) lines.push(`Files modified: ${trace.files_modified.join(", ")}`);
      }
      lines.push("");
    }
    if (output.missing_source_trace_ids.length > 0) {
      lines.push(`Missing traces (missing): ${output.missing_source_trace_ids.map((id) => `trace:${id}`).join(", ")}`);
    }
  }

  if (output.source_evidence.length > 0 || output.missing_evidence_ids.length > 0) {
    lines.push("");
    lines.push("## Supporting Evidence");
    for (const evidence of output.source_evidence) {
      lines.push(`- ${evidence.id} [${evidence.kind}] ${evidence.content}`);
    }
    if (output.missing_evidence_ids.length > 0) {
      lines.push(`Missing evidence (broken link): ${output.missing_evidence_ids.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("## Edges");
  if (output.edges.length === 0) {
    lines.push("(no edges)");
  } else {
    for (const edge of output.edges) {
      const peer = edge.peer_memory
        ? `memory:${edge.peer_memory.id} [${edge.peer_memory.lifecycle_state ?? "unknown"}] ${edge.peer_memory.title}`
        : "(missing memory)";
      lines.push(`- ${edge.direction} ${edge.edge_type} -> ${peer} (confidence ${edge.confidence.toFixed(2)})`);
    }
  }

  lines.push("");
  lines.push("## Context Effects");
  if (output.context_effects.length === 0) {
    lines.push("(no measured effects)");
  } else {
    for (const effect of output.context_effects) {
      lines.push(`- ${effect.verdict} confidence=${effect.confidence.toFixed(2)} injection=${effect.injection_id} episode=${effect.episode_id ?? "(none)"}`);
    }
  }

  lines.push("");
  lines.push("## Feedback");
  if (output.feedback.length === 0) {
    lines.push("(no feedback)");
  } else {
    for (const row of output.feedback) {
      const details = [
        `event=${row.event_type}`,
        `weight=${row.weight.toFixed(2)}`,
        `source=${row.source}`,
        row.context_injection_id ? `context=${row.context_injection_id}` : null,
        row.correction_text ? `correction=${row.correction_text}` : null,
      ].filter((part): part is string => part !== null);
      lines.push(`- ${formatTimestamp(row.created_at)} ${details.join(" ")}`);
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

function summarizeMemory(memory: Memory): ExplainMemory {
  return {
    id: memory.id,
    document_id: `memory:${memory.id}`,
    title: memory.title,
    type: memory.type,
    description: memory.description,
    repo_id: memory.repo_id,
    session_id: memory.session_id,
    workspace_root: memory.workspace_root,
    lifecycle_state: memory.lifecycle_state,
    state: memory.state,
    importance: memory.importance,
    confidence: memory.confidence,
    usage_count: memory.usage_count,
    last_accessed_at: memory.last_accessed_at,
    last_reinforced_at: memory.last_reinforced_at,
    decayed_score: memory.decayed_score,
    content_hash: memory.content_hash,
    canonical_key: memory.canonical_key,
    superseded_by: memory.superseded_by,
    applicability_evidence: memory.applicability_evidence,
    created_at: memory.created_at,
    files_read: memory.files_read,
    files_modified: memory.files_modified,
    source_observation_ids: memory.source_observation_ids,
    source_trace_ids: memory.source_trace_ids,
  };
}

function resolveMemoryId(store: Store, requestedId: string): number | null {
  const direct = requestedId.match(/^(?:memory:)?(\d+)$/);
  if (direct) return Number(direct[1]);

  const row = store.getDB().prepare(
    `SELECT source_id FROM documents WHERE id = ? AND doc_type = 'memory'`,
  ).get(requestedId) as { source_id?: string } | undefined;

  if (!row?.source_id || !/^\d+$/.test(row.source_id)) return null;
  return Number(row.source_id);
}

function emptyExplain(requestedId: string, resolvedId: number | null = null): ExplainOutput {
  return {
    requested_id: requestedId,
    resolved_id: resolvedId,
    found: false,
    memory: null,
    source_observations: [],
    source_traces: [],
    source_evidence: [],
    edges: [],
    feedback: [],
    context_effects: [],
    missing_source_observation_ids: [],
    missing_source_trace_ids: [],
    missing_evidence_ids: [],
    provenance_valid: false,
  };
}

function uniqueIds(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function formatTimestamp(value: number | null | undefined): string {
  if (value == null) return "(none)";
  return new Date(value).toISOString();
}

function formatMaybeNumber(value: number | undefined | null): string {
  return value == null ? "(none)" : value.toFixed(3);
}
