import type { Memory, Observation, Summary } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { HybridSearch, HybridSearchResult } from "../retrieval/hybrid.js";
import { isMemoryEligible } from "../retrieval/eligibility.js";
import { randomUUID } from "node:crypto";
import { scoreMemoryCandidate } from "../retrieval/ranking.js";

export interface ContextInput {
  repo_id?: string;
  query?: string;
  maxMemories?: number;
  currentFiles?: string[];
  sessionId?: string;
  episodeId?: string;
  agent?: string;
  /** Who is requesting context — used for attribution. */
  surface?: string;
  /** Approx maximum tokens to inject. 0 = no budget. Default 0 (legacy behavior).
   * When set, the builder greedily packs in order: summary (10%), observations (30%),
   * memories (60%), each cut off when the sub-budget is exhausted. */
  tokenBudget?: number;
}

export interface ContextOutput {
  memories: Memory[];
  rankedMemories: HybridSearchResult[];
  observations: Observation[];
  summary: Summary | null;
  text: string;
  contextInjectionId: string;
  contextPacketId: string;
}

export class ContextBuilder {
  constructor(private store: Store, private search: HybridSearch) {}

  async build(input: ContextInput): Promise<ContextOutput> {
    const startedAt = Date.now();
    const limit = input.maxMemories ?? 50;
    const repo_id = input.repo_id;
    let rankedMemories: HybridSearchResult[];

    if (input.query) {
      rankedMemories = await this.search.search({
        query: input.query,
        repo_id,
        limit,
        currentFiles: input.currentFiles,
      });
      rankedMemories = rankedMemories.filter((result) => isTaskEligible(result, input.query!, input.currentFiles));
    } else {
      const recent = this.store.getRecentMemories(limit, repo_id).filter((m) => isMemoryEligible(m));
      rankedMemories = recent.slice(0, limit).map((memory, index) => {
        const score_breakdown = scoreMemoryCandidate({ memory, ftsRank: index + 1 });
        return { memory, combined_score: score_breakdown.final_score, score_breakdown };
      });
    }

    const consideredMemories = rankedMemories.slice();
    let allObservations = this.store.getRecentObservations(20, repo_id);
    let allSummary = repo_id ? this.store.getMostRecentSummaryForRepo(repo_id) : null;

    // Token budget packing (greedy block-fit).
    const budget = input.tokenBudget ?? 0;
    if (budget > 0) {
      const summaryBudget = Math.floor(budget * 0.1);
      const obsBudget = Math.floor(budget * 0.3);
      const memBudget = Math.max(budget - summaryBudget - obsBudget, 1);

      allSummary = packSummary(allSummary, summaryBudget);
      allObservations = packObservations(allObservations, obsBudget, 10);
      rankedMemories = packMemories(rankedMemories, memBudget, limit);
    }

    const memories = rankedMemories.map((result) => result.memory);

    const text = renderContext(repo_id ?? "unknown", memories, allObservations, allSummary);

    const packet = this.store.recordContextPacket({
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      repoId: repo_id ?? "unknown",
      agent: input.agent ?? input.surface ?? "unknown",
      task: input.query ?? "Repository context",
      tokenBudget: budget,
      estimatedTokens: estimateTokens(text),
      retrievalMode: consideredMemories.some((result) => result.vector_rank) ? "hybrid" : "fts",
      latencyMs: Date.now() - startedAt,
      renderedText: text,
      candidates: consideredMemories.map((result) => {
        const selectedIndex = rankedMemories.findIndex((selected) => selected.memory.id === result.memory.id);
        const selected = selectedIndex >= 0;
        return {
          candidateId: `memory:${result.memory.id}`,
          kind: result.memory.type === "procedure" ? "procedure" as const : "memory" as const,
          sourceId: String(result.memory.id),
          tokenEstimate: estimateTokens(renderMemory(result.memory)),
          selected,
          rank: selected ? selectedIndex + 1 : null,
          finalScore: result.combined_score,
          scoreBreakdown: result.score_breakdown as unknown as Record<string, unknown>,
          rejectionReason: selected ? null : "token_budget_or_limit",
          renderedText: renderMemory(result.memory),
        };
      }),
    });

    const injectionId = randomUUID();
    this.store.recordContextInjection({
      id: injectionId,
      sessionId: input.sessionId,
      repoId: repo_id,
      query: input.query,
      files: input.currentFiles,
      memoryIds: memories.map((m) => m.id),
      items: rankedMemories.map((result, index) => ({
        memoryId: result.memory.id,
        rank: index + 1,
        score: result.combined_score,
        ftsRank: result.fts_rank,
        vectorRank: result.vector_rank,
        scoreBreakdown: result.score_breakdown,
        renderedText: renderMemory(result.memory),
      })),
      surface: input.surface ?? "unknown",
      packetId: packet.id,
      deliveryMethod: input.surface === "hook" ? "hook" : "cli",
    });

    // Record a `shown` feedback event for each injected memory so exposure is
    // attributable to the injection and later `used`/`corrected` events can
    // link back through the same injection ID.
    for (const m of memories) {
      this.store.recordMemoryFeedback({
        id: `memory:${m.id}`,
        event: "shown",
        contextInjectionId: injectionId,
        source: input.surface ?? "context",
      });
    }

    return {
      memories, rankedMemories, observations: allObservations, summary: allSummary,
      text, contextInjectionId: injectionId, contextPacketId: packet.id,
    };
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
  if (m.applicability_evidence) {
    const evidence = m.applicability_evidence;
    if (evidence.files.length > 0) parts.push(`Applicability files: ${evidence.files.join(", ")}`);
    if (evidence.commands.length > 0) parts.push(`Applicability commands: ${evidence.commands.join(", ")}`);
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isTaskEligible(result: HybridSearchResult, query: string, files?: string[]): boolean {
  if (result.fts_rank != null) return true;
  const haystack = [
    result.memory.title,
    result.memory.description ?? "",
    ...result.memory.files_read,
    ...result.memory.files_modified,
    ...(result.memory.applicability_evidence?.commands ?? []),
  ].join(" ").toLowerCase();
  const technical = [
    ...(files ?? []),
    ...query.match(/[A-Za-z0-9_./\\:-]{4,}/g) ?? [],
  ].map((token) => token.toLowerCase());
  return technical.some((token) => haystack.includes(token));
}

export function packSummary(summary: Summary | null, budget: number): Summary | null {
  if (!summary) return null;
  const rendered = [summary.summary ?? "", ...(summary.key_changes ?? []), ...(summary.key_learnings ?? [])].join("\n");
  if (estimateTokens(rendered) <= budget) return summary;
  const truncated = summary.summary?.slice(0, Math.max(0, budget * 4)) ?? null;
  return { ...summary, summary: truncated, key_changes: (summary.key_changes ?? []).slice(0, 3), key_learnings: (summary.key_learnings ?? []).slice(0, 3) };
}

export function packObservations(
  observations: Observation[],
  budget: number,
  maxCount: number,
): Observation[] {
  const sorted: Observation[] = observations.slice(0, maxCount);
  let received: Observation[] = [];
  let remaining = budget;
  for (let i = 0; i < sorted.length; i++) {
    const text = renderObservation(sorted[i]);
    const tokens = estimateTokens(text);
    if (remaining < tokens) {
      received.push(trimObservation(sorted[i], remaining));
      break;
    }
    remaining -= tokens;
    received.push(sorted[i]);
  }
  return received;
}

function trimObservation(o: Observation, budgetT: number): Observation {
  if (budgetT <= 0) {
    return { ...o, description: null, files_read: [], files_modified: [] };
  }
  const desc = o.description ?? "";
  const maxChars = budgetT * 4;
  return {
    ...o,
    description: desc.length > maxChars ? desc.slice(0, maxChars) + "…" : desc,
    files_read: [],
    files_modified: [],
  };
}

export function packMemories(
  ranked: HybridSearchResult[],
  budget: number,
  maxCount: number,
): HybridSearchResult[] {
  const sorted: HybridSearchResult[] = ranked.slice();
  sorted.sort((a, b) => b.combined_score - a.combined_score);
  const selected: HybridSearchResult[] = [];
  let remaining = budget;
  for (let i = 0; i < sorted.length; i++) {
    if (selected.length >= maxCount) break;
    const text = renderMemory(sorted[i].memory);
    const tokens = estimateTokens(text);
    if (remaining < tokens && selected.length > 0) continue;
    if (remaining < tokens && selected.length === 0) {
      const trimmed: HybridSearchResult = {
        ...sorted[i],
        memory: {
          ...sorted[i].memory,
          description: (sorted[i].memory.description ?? "").slice(0, remaining * 4) + "…",
        },
      };
      selected.push(trimmed);
      remaining = 0;
      break;
    }
    remaining -= tokens;
    selected.push(sorted[i]);
    if (remaining <= 0) break;
  }
  return selected;
}
