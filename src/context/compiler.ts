import type {
  CompiledContextCandidate,
  ContextCandidateKind,
  ContextRejectionReason,
  Evidence,
  Memory,
  Observation,
  Summary,
} from "../shared/types.js";
import type { HybridSearchResult } from "./retrieval/hybrid.js";
import { isMemoryEligible } from "./retrieval/eligibility.js";
import type { Store } from "../storage/store.js";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { checkFreshness } from "./freshness.js";

const MIN_SCORE = 0.008;

export interface CompileContextInput {
  repoId: string;
  query?: string;
  currentFiles?: string[];
  tokenBudget: number;
  maxMemories: number;
  rankedMemories: HybridSearchResult[];
}

export interface CompileContextOutput {
  text: string;
  estimatedTokens: number;
  candidates: CompiledContextCandidate[];
}

interface CandidateSource {
  memory?: Memory;
  observation?: Observation;
  summary?: Summary;
  evidence?: Evidence;
}

type WorkingCandidate = CompiledContextCandidate & CandidateSource;

export class ContextCompiler {
  constructor(private readonly store: Store) {}

  compile(input: CompileContextInput): CompileContextOutput {
    const candidates = this.generateCandidates(input);
    const framing = `# Termyte Context for ${input.repoId}\nUse this as prior evidence, not as a substitute for checking the current repository.\n`;
    const framingTokens = estimateTokens(`${framing}\n`);
    const budget = input.tokenBudget > 0 ? input.tokenBudget : Number.POSITIVE_INFINITY;
    let remaining = Math.max(0, budget - framingTokens);
    let rank = 0;
    let selectedMemories = 0;
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (candidate.applicability_state !== "stale_exact_match") continue;
      const strongerActive = candidates.some((other) =>
        other !== candidate
        && !other.rejection_reason
        && other.lifecycle_state !== "stale"
        && other.final_score > candidate.final_score,
      );
      if (strongerActive) {
        candidate.rejection_reason = "redundant";
        candidate.applicability_state = "ineligible";
      }
    }

    candidates.sort((a, b) =>
      b.final_score - a.final_score
      || a.kind.localeCompare(b.kind)
      || (a.source_id ?? "").localeCompare(b.source_id ?? ""),
    );

    for (const candidate of candidates) {
      if (candidate.rejection_reason) continue;
      if (candidate.final_score < MIN_SCORE) {
        candidate.rejection_reason = "below_threshold";
        continue;
      }
      const normalized = normalizeContent(candidate.rendered_text);
      if (seen.has(normalized)) {
        candidate.rejection_reason = "redundant";
        continue;
      }
      if (candidate.token_estimate > remaining) {
        if (rank === 0 && remaining >= 12) {
          const truncated = truncateCandidate(candidate.rendered_text, remaining);
          if (truncated) {
            candidate.rendered_text = truncated;
            candidate.token_estimate = estimateTokens(`${truncated}\n\n`);
          }
        }
        if (candidate.token_estimate > remaining) {
          candidate.rejection_reason = "token_budget";
          continue;
        }
      }
      if ((candidate.kind === "memory" || candidate.kind === "procedure") && selectedMemories >= input.maxMemories) {
        candidate.rejection_reason = "token_budget";
        continue;
      }
      candidate.selected = true;
      candidate.rank = ++rank;
      remaining -= candidate.token_estimate;
      seen.add(normalized);
      if (candidate.kind === "memory" || candidate.kind === "procedure") selectedMemories++;
    }

    const selected = candidates.filter((candidate) => candidate.selected).sort((a, b) => a.rank! - b.rank!);
    const text = selected.length > 0
      ? `${framing}\n${selected.map((candidate) => candidate.rendered_text).join("\n\n")}\n`
      : "";
    return {
      text,
      estimatedTokens: text ? estimateTokens(text) : 0,
      candidates,
    };
  }

  private generateCandidates(input: CompileContextInput): WorkingCandidate[] {
    const candidates: WorkingCandidate[] = [this.candidate({
      kind: "current_state",
      sourceId: input.repoId,
      text: `Repository: ${input.repoId}\nTask: ${input.query ?? "Repository context"}`,
      score: { metadata: 0 },
      rejection: "below_threshold",
    })];
    const broken = new Set(this.store.getActiveMemoryProvenanceViolations());
    for (const result of input.rankedMemories) {
      const memory = result.memory;
      const text = memoryText(memory);
      const exactMatch = hasExactTechnicalMatch(text, input);
      const declaresProvenance = memory.source_observation_ids.length > 0
        || memory.source_trace_ids.length > 0
        || this.store.getMemoryEvidenceLinks(memory.id).length > 0;
      const rejection = memory.repo_id !== input.repoId
        ? "wrong_repository"
        : !isMemoryEligible(memory) && !(memory.lifecycle_state === "stale" && exactMatch)
          ? "ineligible_lifecycle"
          : broken.has(memory.id) && declaresProvenance
            ? "broken_provenance"
            : hasMissingFile(memory) ? "missing_file" : freshnessRejection(memory.workspace_root, [...memory.files_read, ...memory.files_modified]);
      candidates.push(this.candidate({
        kind: memory.type === "procedure" ? "procedure" : "memory",
        sourceId: String(memory.id),
        text: renderMemory(memory, memory.lifecycle_state === "stale" && exactMatch),
        score: scoreText(text, input, result.fts_rank != null ? result.combined_score : 0, 0.006),
        rejection,
        lifecycle: memory.lifecycle_state ?? "active",
        applicability: memory.lifecycle_state === "stale" && exactMatch ? "stale_exact_match" : undefined,
        source: { memory },
      }));
    }

    for (const observation of this.store.getRecentObservations(20, input.repoId)) {
      candidates.push(this.candidate({
        kind: "observation", sourceId: String(observation.id), text: renderObservation(observation),
        score: scoreText(observationText(observation), input, 0, 0.004),
        lifecycle: observation.lifecycle_state, source: { observation },
      }));
    }

    const summary = this.store.getMostRecentSummaryForRepo(input.repoId);
    if (summary) {
      candidates.push(this.candidate({
        kind: "summary", sourceId: String(summary.id), text: renderSummary(summary),
        score: scoreText(summaryText(summary), input, 0, 0.007), source: { summary },
      }));
    }

    for (const evidence of this.store.getRecentEvidenceForRepo(input.repoId, 30)) {
      candidates.push(this.candidate({
        kind: "evidence", sourceId: evidence.id, text: renderEvidence(evidence),
        score: scoreText(`${evidence.kind} ${evidence.content}`, input, 0, evidence.exit_code === 0 ? 0.008 : 0.005),
        source: { evidence },
      }));
    }

    return candidates;
  }

  private candidate(input: {
    kind: ContextCandidateKind;
    sourceId: string;
    text: string;
    score: Record<string, number>;
    rejection?: ContextRejectionReason | null;
    lifecycle?: string | null;
    applicability?: "applicable" | "stale_exact_match" | "ineligible";
    source?: CandidateSource;
  }): WorkingCandidate {
    const finalScore = Object.entries(input.score)
      .filter(([key]) => key !== "final_score")
      .reduce((sum, [, value]) => sum + value, 0);
    return {
      candidate_id: `${input.kind}:${input.sourceId}`,
      kind: input.kind,
      source_id: input.sourceId,
      rendered_text: input.text,
      token_estimate: estimateTokens(`${input.text}\n\n`),
      final_score: finalScore,
      score_breakdown: { ...input.score, final_score: finalScore },
      lifecycle_state: input.lifecycle ?? null,
      applicability_state: input.rejection ? "ineligible" : input.applicability ?? "applicable",
      selected: false,
      rank: null,
      rejection_reason: input.rejection ?? null,
      ...input.source,
    };
  }
}

function scoreText(text: string, input: CompileContextInput, retrieval: number, quality: number): Record<string, number> {
  const normalized = normalize(text);
  const query = normalize(input.query ?? "");
  const files = (input.currentFiles ?? []).map(normalizePath);
  const exactPath = files.some((file) => file && normalized.includes(file)) ? 0.05 : 0;
  const technical = technicalTokens(`${input.query ?? ""} ${(input.currentFiles ?? []).join(" ")}`);
  const exactTechnical = technical.some((token) => normalized.includes(token)) ? 0.04 : 0;
  const queryTokens = new Set(query.split(" ").filter((token) => token.length > 2));
  const overlap = [...queryTokens].filter((token) => normalized.includes(token)).length;
  const sparse = queryTokens.size > 0 ? 0.02 * (overlap / queryTokens.size) : 0.012;
  return {
    retrieval_score: retrieval,
    exact_path: exactPath,
    exact_technical: exactTechnical,
    sparse_relevance: sparse,
    evidence_quality: quality,
    token_cost: -Math.min(0.005, estimateTokens(text) / 100_000),
  };
}

function renderMemory(memory: Memory, verificationRequired = false): string {
  const lines = [`## memory:${memory.id} [${memory.type}] ${memory.title}`];
  if (verificationRequired) lines.push("Warning: stale exact match; verify against the current repository before use.");
  if (memory.description) lines.push(memory.description);
  const files = [...new Set([...memory.files_modified, ...memory.files_read])];
  if (files.length > 0) lines.push(`Files: ${files.join(", ")}`);
  lines.push(`ID: memory:${memory.id}`);
  return lines.join("\n");
}

function renderObservation(observation: Observation): string {
  const lines = [`## observation:${observation.id} [${observation.type}] ${observation.title}`];
  if (observation.description) lines.push(observation.description);
  const files = [...new Set([...observation.files_modified, ...observation.files_read])];
  if (files.length > 0) lines.push(`Files: ${files.join(", ")}`);
  return lines.join("\n");
}

function renderSummary(summary: Summary): string {
  const lines = [`## summary:${summary.id}`];
  if (summary.summary) lines.push(summary.summary);
  for (const change of summary.key_changes ?? []) lines.push(`- Change: ${change}`);
  for (const learning of summary.key_learnings ?? []) lines.push(`- Learning: ${learning}`);
  return lines.join("\n");
}

function renderEvidence(evidence: Evidence): string {
  return `## ${evidence.id} [${evidence.kind}]\n${evidence.content}${evidence.exit_code === null ? "" : `\nExit: ${evidence.exit_code}`}`;
}

function memoryText(memory: Memory): string {
  return [memory.title, memory.description ?? "", ...memory.files_read, ...memory.files_modified, ...(memory.applicability_evidence?.commands ?? [])].join(" ");
}
function observationText(observation: Observation): string {
  return [observation.title, observation.description ?? "", ...observation.files_read, ...observation.files_modified, ...observation.commands_executed].join(" ");
}
function summaryText(summary: Summary): string {
  return [summary.summary ?? "", ...(summary.key_changes ?? []), ...(summary.key_learnings ?? [])].join(" ");
}
function technicalTokens(value: string): string[] {
  return [...new Set((value.match(/[A-Za-z0-9_.:/\\-]{4,}/g) ?? []).map(normalizePath))];
}
function hasExactTechnicalMatch(text: string, input: CompileContextInput): boolean {
  const normalized = normalize(text);
  return technicalTokens(`${input.query ?? ""} ${(input.currentFiles ?? []).join(" ")}`)
    .some((token) => normalized.includes(token));
}
function hasMissingFile(memory: Memory): boolean {
  if (!existsSync(memory.workspace_root)) return false;
  const root = resolve(memory.workspace_root);
  return [...new Set([...memory.files_read, ...memory.files_modified])].some((file) => {
    if (isAbsolute(file)) return true;
    const target = resolve(root, file);
    const local = relative(root, target);
    if (!local || local === ".." || local.startsWith("../") || local.startsWith("..\\") || isAbsolute(local)) return true;
    return !existsSync(target);
  });
}
function freshnessRejection(workspaceRoot: string, files: string[]): "missing_file" | "freshness_changed" | null {
  const state = checkFreshness(workspaceRoot, files).state;
  return state === "stale" ? "missing_file" : state === "changed" ? "freshness_changed" : null;
}
function truncateCandidate(text: string, budget: number): string | null {
  const [provenance, ...rest] = text.split("\n");
  if (!provenance || estimateTokens(`${provenance}\n`) >= budget) return null;
  const maxChars = Math.max(0, budget * 4 - provenance.length - 8);
  const detail = rest.join("\n").slice(0, maxChars).trimEnd();
  return detail ? `${provenance}\n${detail}...` : provenance;
}
function normalizePath(value: string): string { return value.replaceAll("\\", "/").toLowerCase(); }
function normalize(value: string): string { return normalizePath(value).replace(/[^a-z0-9_./:-]+/g, " ").trim(); }
function normalizeContent(value: string): string { return normalize(value).replace(/\b(?:memory|observation|summary|evidence|episode):[^ ]+/g, ""); }
export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
