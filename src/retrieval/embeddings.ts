/**
 * Pluggable embedding provider. Termyte uses local embeddings only
 * (ONNX via @xenova/transformers) — no external API calls.
 *
 * The vector store is in-process and holds vectors in memory; embeddings are
 * persisted to the `memories.embedding` BLOB column on insert, so the
 * in-process cache can be rehydrated from disk on restart.
 *
 * `NoOpEmbeddingsProvider` is the documented "no embeddings" fallback.
 * It's exposed in the public API (createTermyte) so users can opt out
 * of embeddings entirely. Most production code should not instantiate
 * it directly — pass `{ model: null }` to createTermyte instead.
 */

export interface EmbeddingsProvider {
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export class NoOpEmbeddingsProvider implements EmbeddingsProvider {
  readonly dimensions = 0;
  async embed(): Promise<Float32Array> {
    throw new Error("No embeddings provider configured");
  }
  async embedBatch(): Promise<Float32Array[]> {
    throw new Error("No embeddings provider configured");
  }
}
