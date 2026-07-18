import { randomUUID } from "node:crypto";
import type { Memory, Observation, Summary } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { HybridSearch, HybridSearchResult } from "../retrieval/hybrid.js";
import { isMemoryEligible } from "../retrieval/eligibility.js";
import { scoreMemoryCandidate } from "../retrieval/ranking.js";
import { ContextCompiler } from "./compiler.js";
import { ResumeCompiler } from "../task-state/resume.js";

export interface ContextInput {
  repo_id?: string;
  query?: string;
  maxMemories?: number;
  currentFiles?: string[];
  sessionId?: string;
  episodeId?: string;
  agent?: string;
  surface?: string;
  tokenBudget?: number;
}

export interface ContextOutput {
  memories: Memory[];
  rankedMemories: HybridSearchResult[];
  observations: Observation[];
  summary: Summary | null;
  text: string;
  contextInjectionId: string | null;
  contextPacketId: string;
}

export class ContextBuilder {
  private readonly compiler: ContextCompiler;

  constructor(private readonly store: Store, private readonly search: HybridSearch) {
    this.compiler = new ContextCompiler(store);
  }

  async build(input: ContextInput): Promise<ContextOutput> {
    const startedAt = Date.now();
    const limit = input.maxMemories ?? 50;
    const repoId = input.repo_id ?? "unknown";
    const taskText = this.renderActiveTask(repoId);
    const taskTokens = Math.ceil(taskText.length / 4);
    let consideredMemories: HybridSearchResult[];

    if (input.query) {
      consideredMemories = await this.search.search({
        query: input.query,
        repo_id: input.repo_id,
        limit,
        currentFiles: input.currentFiles,
      });
    } else {
      consideredMemories = this.store.getRecentMemories(limit, input.repo_id)
        .filter((memory) => isMemoryEligible(memory))
        .map((memory, index) => {
          const score_breakdown = scoreMemoryCandidate({ memory, ftsRank: index + 1 });
          return { memory, combined_score: score_breakdown.final_score, score_breakdown };
        });
    }

    const compiled = this.compiler.compile({
      repoId,
      query: input.query,
      currentFiles: input.currentFiles,
      tokenBudget: input.tokenBudget ? Math.max(0, input.tokenBudget - taskTokens) : 0,
      maxMemories: limit,
      rankedMemories: consideredMemories,
    });
    const selected = new Set(compiled.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.candidate_id));
    const selectedRank = new Map(compiled.candidates
      .filter((candidate) => candidate.selected)
      .map((candidate) => [candidate.candidate_id, candidate.rank ?? Number.MAX_SAFE_INTEGER]));
    const rankedMemories = consideredMemories.filter((result) =>
      selected.has(`${result.memory.type === "procedure" ? "procedure" : "memory"}:${result.memory.id}`),
    ).sort((a, b) => {
      const aId = `${a.memory.type === "procedure" ? "procedure" : "memory"}:${a.memory.id}`;
      const bId = `${b.memory.type === "procedure" ? "procedure" : "memory"}:${b.memory.id}`;
      return (selectedRank.get(aId) ?? 0) - (selectedRank.get(bId) ?? 0);
    });
    const memories = rankedMemories.map((result) => result.memory);
    const observations = this.store.getRecentObservations(20, input.repo_id)
      .filter((observation) => selected.has(`observation:${observation.id}`));
    const candidateSummary = this.store.getMostRecentSummaryForRepo(repoId);
    const summary = candidateSummary && selected.has(`summary:${candidateSummary.id}`) ? candidateSummary : null;

    const renderedText = taskText + compiled.text;
    const packet = this.store.recordContextPacket({
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      repoId,
      agent: input.agent ?? input.surface ?? "unknown",
      task: input.query ?? "Repository context",
      tokenBudget: input.tokenBudget ?? 0,
      estimatedTokens: compiled.estimatedTokens + taskTokens,
      retrievalMode: consideredMemories.some((result) => result.vector_rank) ? "hybrid" : "fts",
      latencyMs: Date.now() - startedAt,
      renderedText,
      candidates: [...(taskText ? [{
        candidateId: `authoritative_task:${repoId}`, kind: "current_state" as const, sourceId: repoId,
        tokenEstimate: taskTokens, selected: true, rank: 1, finalScore: 1,
        scoreBreakdown: { authoritative: 1 }, rejectionReason: null, renderedText: taskText,
      }] : []), ...compiled.candidates.map((candidate) => ({
        candidateId: candidate.candidate_id,
        kind: candidate.kind,
        sourceId: candidate.source_id,
        tokenEstimate: candidate.token_estimate,
        selected: candidate.selected,
        rank: candidate.rank,
        finalScore: candidate.final_score,
        scoreBreakdown: candidate.score_breakdown,
        rejectionReason: candidate.rejection_reason,
        renderedText: candidate.rendered_text,
      }))],
    });

    const injectionId = renderedText ? randomUUID() : null;
    if (injectionId) this.store.recordContextInjection({
      id: injectionId,
      sessionId: input.sessionId,
      repoId: input.repo_id,
      query: input.query,
      files: input.currentFiles,
      memoryIds: memories.map((memory) => memory.id),
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

    for (const memory of injectionId ? memories : []) {
      this.store.recordMemoryFeedback({
        id: `memory:${memory.id}`,
        event: "shown",
        contextInjectionId: injectionId!,
        source: input.surface ?? "context",
      });
    }

    return {
      memories,
      rankedMemories,
      observations,
      summary,
      text: renderedText,
      contextInjectionId: injectionId,
      contextPacketId: packet.id,
    };
  }

  private renderActiveTask(repoId: string): string {
    const rows = this.store.getDB().prepare(`SELECT id FROM tasks WHERE repo_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 2`).all(repoId) as Array<{ id: string }>;
    if (rows.length !== 1) return "";
    const packet = new ResumeCompiler(this.store.getDB()).compile(rows[0]!.id);
    return `# Authoritative Termyte Task State\nThis state is primary; historical memory below is supplemental.\n\n${JSON.stringify(packet, null, 2)}\n\n`;
  }
}

export function renderContext(scope: string, memories: Memory[], observations: Observation[], summary: Summary | null): string {
  const blocks: string[] = [];
  if (summary) blocks.push(renderSummary(summary));
  blocks.push(...memories.map(renderMemoryCard));
  blocks.push(...observations.map(renderObservation));
  return blocks.length > 0 ? `# Termyte Context for ${scope}\n\n${blocks.join("\n\n")}\n` : "";
}

export function renderMemory(memory: Memory): string {
  const lines = [`### [${memory.type}] ${memory.title}`];
  if (memory.description) lines.push(memory.description);
  if (memory.files_read.length > 0) lines.push(`Files read: ${memory.files_read.join(", ")}`);
  if (memory.files_modified.length > 0) lines.push(`Files modified: ${memory.files_modified.join(", ")}`);
  return lines.join("\n");
}

export function renderMemoryCard(memory: Memory): string {
  const description = memory.description?.replace(/\s+/g, " ").trim();
  const lines = [`## memory:${memory.id} [${memory.type}] ${memory.title}`];
  if (description) lines.push(description.length > 240 ? `${description.slice(0, 237)}...` : description);
  const files = memory.files_modified.length > 0 ? memory.files_modified : memory.files_read;
  if (files.length > 0) lines.push(`Files: ${files.join(", ")}`);
  lines.push(`ID: memory:${memory.id}`);
  return lines.join("\n");
}

function renderObservation(observation: Observation): string {
  const lines = [`## observation:${observation.id} [${observation.type}] ${observation.title}`];
  if (observation.description) lines.push(observation.description);
  return lines.join("\n");
}

function renderSummary(summary: Summary): string {
  const lines = [`## summary:${summary.id}`];
  if (summary.summary) lines.push(summary.summary);
  return lines.join("\n");
}

export function renderHybridResults(results: HybridSearchResult[]): string {
  return results.map((result) => {
    const lines = [`#${result.memory.id} [${result.memory.type}] ${result.memory.title} (score: ${result.combined_score.toFixed(3)})`];
    const files = [...new Set([...result.memory.files_read, ...result.memory.files_modified])];
    if (files.length > 0) lines.push(`Files: ${files.join(", ")}`);
    return lines.join("\n");
  }).join("\n\n");
}
