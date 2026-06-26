import type { Memory, Observation, Summary } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { HybridSearch, HybridSearchResult } from "../retrieval/hybrid.js";

export interface ContextInput {
  repo_id?: string;
  query?: string;
  maxMemories?: number;
  currentFiles?: string[];
}

export interface ContextOutput {
  memories: Memory[];
  observations: Observation[];
  summary: Summary | null;
  text: string;
}

export class ContextBuilder {
  constructor(private store: Store, private search: HybridSearch) {}

  async build(input: ContextInput): Promise<ContextOutput> {
    const limit = input.maxMemories ?? 50;
    const repo_id = input.repo_id;
    let memories: Memory[];

    if (input.query) {
      const results = await this.search.search({
        query: input.query,
        repo_id,
        limit,
        currentFiles: input.currentFiles,
      });
      memories = results.map((r) => r.memory);
    } else {
      memories = this.store.getRecentMemories(limit, repo_id);
    }

    const observations = this.store.getRecentObservations(20, repo_id);
    const summary = repo_id ? this.store.getMostRecentSummaryForRepo(repo_id) : null;
    const text = renderContext(repo_id ?? "unknown", memories, observations, summary);

    return { memories, observations, summary, text };
  }
}

export function renderContext(
  scope: string,
  memories: Memory[],
  observations: Observation[],
  summary: Summary | null,
): string {
  const lines: string[] = [];
  lines.push(`# Memory Context for ${scope}`);
  lines.push("");

  if (summary) {
    lines.push("## Most Recent Session Summary");
    if (summary.summary) lines.push(summary.summary);
    if (summary.key_changes && summary.key_changes.length > 0) {
      lines.push("");
      lines.push("**Key Changes:**");
      for (const c of summary.key_changes) lines.push(`- ${c}`);
    }
    if (summary.key_learnings && summary.key_learnings.length > 0) {
      lines.push("");
      lines.push("**Key Learnings:**");
      for (const l of summary.key_learnings) lines.push(`- ${l}`);
    }
    lines.push("");
  }

  if (memories.length > 0) {
    lines.push(`## Memories (${memories.length})`);
    lines.push("");
    for (const m of memories) {
      lines.push(renderMemory(m));
      lines.push("");
    }
  }

  if (observations.length > 0) {
    lines.push(`## Recent Observations (${observations.length})`);
    lines.push("");
    for (const o of observations) {
      lines.push(renderObservation(o));
      lines.push("");
    }
  }

  if (memories.length === 0 && observations.length === 0) {
    lines.push("(no memories or observations yet)");
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function renderMemory(m: Memory): string {
  const parts: string[] = [];
  parts.push(`### [${m.type}] ${m.title}`);
  if (m.description) parts.push(m.description);
  if (m.files_read.length > 0) {
    parts.push(`Files read: ${m.files_read.join(", ")}`);
  }
  if (m.files_modified.length > 0) {
    parts.push(`Files modified: ${m.files_modified.join(", ")}`);
  }
  if (m.source_observation_ids.length > 0) {
    parts.push(`Source observations: ${m.source_observation_ids.join(", ")}`);
  }
  return parts.join("\n");
}

function renderObservation(o: Observation): string {
  const parts: string[] = [];
  parts.push(`### [${o.type}] ${o.title}`);
  if (o.description) parts.push(o.description);
  if (o.files_read.length > 0) {
    parts.push(`Files read: ${o.files_read.join(", ")}`);
  }
  if (o.files_modified.length > 0) {
    parts.push(`Files modified: ${o.files_modified.join(", ")}`);
  }
  return parts.join("\n");
}

export function renderHybridResults(results: HybridSearchResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`#${r.memory.id} [${r.memory.type}] ${r.memory.title} (score: ${r.combined_score.toFixed(3)})`);
    if (r.memory.description) {
      const first = r.memory.description.split("\n")[0] ?? "";
      if (first) lines.push(`  ${first.slice(0, 200)}`);
    }
    if (r.memory.files_read.length > 0) lines.push(`  Files: ${r.memory.files_read.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
