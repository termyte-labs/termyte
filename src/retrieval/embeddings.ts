/**
 * Pluggable embedding provider. The default is OpenAI-compatible HTTP.
 *
 * The vector store is in-process and holds vectors in memory; embeddings are
 * persisted to the `memories.embedding` BLOB column on insert, so the
 * in-process cache can be rehydrated from disk on restart.
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

export interface OpenAIEmbeddingsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  readonly dimensions: number;
  private cache = new Map<string, Float32Array>();

  constructor(private config: OpenAIEmbeddingsConfig) {
    this.dimensions = config.dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const key = text.slice(0, 256);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const [vec] = await this.embedBatch([text]);
    if (vec) this.cache.set(key, vec);
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { "Authorization": `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`embeddings request failed: ${response.status} ${response.statusText} ${text}`);
    }
    const data = (await response.json()) as any;
    return data.data.map((item: any) => new Float32Array(item.embedding));
  }
}
