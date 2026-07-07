import { describe, expect, it } from "vitest";
import type { Memory } from "../src/core/types.js";
import { scoreMemoryCandidate } from "../src/retrieval/ranking.js";

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 1, session_id: "s", repo_id: "r", workspace_root: "/r", type: "fact",
    title: "fact", description: "fact", files_read: [], files_modified: [],
    source_observation_ids: [], source_trace_ids: [], created_at: 1, embedding: null,
    importance: 0.5, confidence: 0.5, decayed_score: 0.5, usage_count: 0,
    ...overrides,
  };
}

describe("bounded retrieval ranking signals", () => {
  it("leaves neutral candidates at their RRF score", () => {
    const score = scoreMemoryCandidate({ memory: memory(), ftsRank: 1, vectorRank: 1 });
    expect(score.multiplier).toBe(1);
    expect(score.final_score).toBe(score.base_score);
  });

  it("rewards strong corroborated signals without exceeding the cap", () => {
    const score = scoreMemoryCandidate({
      memory: memory({ importance: 1, confidence: 1, decayed_score: 1, usage_count: 100 }),
      ftsRank: 2, vectorRank: 2, feedbackScore: 1,
    });
    expect(score.multiplier).toBe(1.25);
    expect(score.final_score).toBeGreaterThan(score.base_score);
  });

  it("suppresses harmful signals without deleting relevance", () => {
    const score = scoreMemoryCandidate({
      memory: memory({ importance: 0, confidence: 0, decayed_score: 0 }),
      ftsRank: 1, feedbackScore: -1,
    });
    expect(score.multiplier).toBe(0.75);
    expect(score.final_score).toBeGreaterThan(0);
  });

  it("boosts memories whose applicability evidence matches the query and files", () => {
    const score = scoreMemoryCandidate({
      memory: memory({
        applicability_evidence: {
          files: ["src/auth/token.ts"],
          commands: ["npm test"],
          trace_ids: [10],
          observation_ids: [20],
        },
      }),
      ftsRank: 1,
      query: "npm test",
      currentFiles: ["src/auth/token.ts"],
    });
    expect(score.applicability_adjustment).toBeGreaterThan(0);
    expect(score.multiplier).toBeGreaterThan(1);
  });
});
