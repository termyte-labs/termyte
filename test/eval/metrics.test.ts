import { describe, expect, it } from "vitest";
import { mrr, precisionAtK, recallAtK } from "../../src/eval/metrics.js";

describe("eval metrics", () => {
  it("computes recall, precision, and reciprocal rank", () => {
    const results = [{ id: "a" }, { id: "b" }, { id: "c" }];

    expect(recallAtK(results, ["b", "d"], 2)).toBe(0.5);
    expect(precisionAtK(results, ["b", "d"], 2)).toBe(0.5);
    expect(mrr(results, ["c"])).toBeCloseTo(1 / 3);
  });

  it("handles empty expectations as perfect recall", () => {
    expect(recallAtK([], [], 5)).toBe(1);
    expect(mrr([], [])).toBe(1);
  });
});