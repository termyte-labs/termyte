import { describe, expect, it } from "vitest";
import { splitEmbeddingBatch } from "../src/retrieval/local-embeddings.js";

describe("local embeddings batch handling", () => {
  it("splits flattened batch tensors into one vector per input text", () => {
    const batch = new Float32Array([
      1, 2, 3, 4,
      5, 6, 7, 8,
    ]);
    const vectors = splitEmbeddingBatch(batch, 4, 2);
    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors![0]!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(vectors![1]!)).toEqual([5, 6, 7, 8]);
  });

  it("returns null for malformed batch shapes", () => {
    expect(splitEmbeddingBatch(new Float32Array([1, 2, 3]), 4, 1)).toBeNull();
    expect(splitEmbeddingBatch(new Float32Array([1, 2, 3, 4]), 0, 1)).toBeNull();
  });
});
