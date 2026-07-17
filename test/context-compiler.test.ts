import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextCompiler, estimateTokens } from "../src/context/compiler.js";
import type { Memory } from "../src/core/types.js";
import type { HybridSearchResult } from "../src/retrieval/hybrid.js";
import { scoreMemoryCandidate } from "../src/retrieval/ranking.js";
import { openDatabase } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";

describe("ContextCompiler", () => {
  it("lets an exact summary beat and reject a weak vector-only memory", () => {
    const store = setup();
    store.upsertSummary({
      session_id: "s1", repo_id: "r1", workspace_root: "/w",
      summary: "Fix AUTH_ERR_401 by refreshing the token cache.",
      key_changes: [], key_learnings: [], created_at: 2,
    });
    const memory = seedMemory(store, { title: "Unrelated formatting convention" });
    const out = new ContextCompiler(store).compile({
      repoId: "r1", query: "AUTH_ERR_401", tokenBudget: 120, maxMemories: 5,
      rankedMemories: [ranked(memory, { vectorRank: 1 })],
    });

    const summary = out.candidates.find((candidate) => candidate.kind === "summary")!;
    const weak = out.candidates.find((candidate) => candidate.kind === "memory")!;
    expect(summary.selected).toBe(true);
    expect(weak.rejection_reason).toBe("below_threshold");
    expect(out.text).toContain("AUTH_ERR_401");
    store.close();
  });

  it("ranks exact normalized paths above vague retrieval and persists additive components", () => {
    const store = setup();
    const exact = seedMemory(store, { title: "Authentication path", files_read: ["src\\auth.ts"] });
    const vague = seedMemory(store, { title: "General authentication notes" });
    const out = new ContextCompiler(store).compile({
      repoId: "r1", query: "update auth", currentFiles: ["src/auth.ts"], tokenBudget: 200, maxMemories: 5,
      rankedMemories: [ranked(vague, { ftsRank: 1 }), ranked(exact, { ftsRank: 2 })],
    });
    const exactCandidate = out.candidates.find((candidate) => candidate.source_id === String(exact.id))!;
    const vagueCandidate = out.candidates.find((candidate) => candidate.source_id === String(vague.id))!;
    expect(exactCandidate.final_score).toBeGreaterThan(vagueCandidate.final_score);
    const componentSum = Object.entries(exactCandidate.score_breakdown)
      .filter(([key]) => key !== "final_score")
      .reduce((sum, [, value]) => sum + value, 0);
    expect(exactCandidate.final_score).toBeCloseTo(componentSum, 10);
    store.close();
  });

  it("packs deterministically within budget and abstains on an adversarial query", () => {
    const store = setup();
    const memory = seedMemory(store, { title: "Package validation", description: "Run npm test and npm pack before release." });
    const compiler = new ContextCompiler(store);
    const input = {
      repoId: "r1", query: "npm pack", tokenBudget: 35, maxMemories: 5,
      rankedMemories: [ranked(memory, { ftsRank: 1 })],
    };
    const first = compiler.compile(input);
    const second = compiler.compile(input);
    expect(first.estimatedTokens).toBeLessThanOrEqual(35);
    expect(first.candidates.map(signature)).toEqual(second.candidates.map(signature));
    expect(estimateTokens(first.text)).toBe(first.estimatedTokens);

    const abstained = compiler.compile({
      ...input, query: "ZZZ_ADVERSARIAL_NO_MATCH", tokenBudget: 100,
      rankedMemories: [ranked(memory, { vectorRank: 1 })],
    });
    expect(abstained.text).toBe("");
    expect(abstained.candidates.find((candidate) => candidate.kind === "memory")?.rejection_reason).toBe("below_threshold");
    store.close();
  });

  it("rejects unsafe applicability states but admits an exact stale match", () => {
    const store = setup();
    const root = mkdtempSync(join(tmpdir(), "termyte-compiler-"));
    try {
      const wrongRepo = seedMemory(store, { repo_id: "r2", title: "src/auth.ts" });
      const broken = seedMemory(store, { title: "src/auth.ts broken", source_trace_ids: [999] });
      const missing = seedMemory(store, { title: "src/auth.ts missing", workspace_root: root, files_read: ["src/auth.ts"] });
      const staleInserted = seedMemory(store, { title: "src/auth.ts stale" });
      store.updateMemoryLifecycleState(staleInserted.id, "stale");
      const stale = store.getMemory(staleInserted.id)!;
      const out = new ContextCompiler(store).compile({
        repoId: "r1", query: "src/auth.ts", currentFiles: ["src/auth.ts"], tokenBudget: 200, maxMemories: 5,
        rankedMemories: [wrongRepo, broken, missing, stale].map((memory, index) => ranked(memory, { ftsRank: index + 1 })),
      });
      const reason = (id: number) => out.candidates.find((candidate) => candidate.source_id === String(id))?.rejection_reason;
      expect(reason(wrongRepo.id)).toBe("wrong_repository");
      expect(reason(broken.id)).toBe("broken_provenance");
      expect(reason(missing.id)).toBe("missing_file");
      expect(out.candidates.find((candidate) => candidate.source_id === String(stale.id))).toMatchObject({
        selected: true,
        applicability_state: "stale_exact_match",
      });
      expect(out.text).toContain("verify against the current repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
      store.close();
    }
  });

  it("rejects a stale exact match when a stronger active answer exists", () => {
    const store = setup();
    const active = seedMemory(store, { title: "src/auth.ts active", files_read: ["src/auth.ts"] });
    const staleInserted = seedMemory(store, { title: "src/auth.ts stale" });
    store.updateMemoryLifecycleState(staleInserted.id, "stale");
    const stale = store.getMemory(staleInserted.id)!;
    const out = new ContextCompiler(store).compile({
      repoId: "r1", query: "src/auth.ts", currentFiles: ["src/auth.ts"], tokenBudget: 200, maxMemories: 5,
      rankedMemories: [ranked(active, { ftsRank: 1 }), ranked(stale, { ftsRank: 2 })],
    });
    expect(out.candidates.find((candidate) => candidate.source_id === String(active.id))?.selected).toBe(true);
    expect(out.candidates.find((candidate) => candidate.source_id === String(stale.id))).toMatchObject({
      selected: false,
      rejection_reason: "redundant",
    });
    store.close();
  });
});

function setup(): Store {
  const store = new Store(openDatabase(":memory:"));
  store.upsertSession("s1", "repo", "r1", "/w");
  return store;
}

function seedMemory(store: Store, overrides: Partial<Memory>): Memory {
  return store.insertMemory({
    session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "fact",
    title: "Fact", description: null, files_read: [], files_modified: [],
    source_observation_ids: [], source_trace_ids: [], created_at: 1, embedding: null,
    ...overrides,
  });
}

function ranked(memory: Memory, ranks: { ftsRank?: number; vectorRank?: number }): HybridSearchResult {
  const score_breakdown = scoreMemoryCandidate({ memory, ftsRank: ranks.ftsRank, vectorRank: ranks.vectorRank });
  return {
    memory,
    fts_rank: ranks.ftsRank,
    vector_rank: ranks.vectorRank,
    combined_score: score_breakdown.final_score,
    score_breakdown,
  };
}

function signature(candidate: { candidate_id: string; selected: boolean; rank: number | null; rejection_reason: string | null }) {
  return [candidate.candidate_id, candidate.selected, candidate.rank, candidate.rejection_reason];
}
