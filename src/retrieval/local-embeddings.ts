/**
 * Local embeddings provider using Transformers.js.
 *
 * Uses Nomic Embed Text v1.5 (768 dims, matryoshka-capable) by default.
 * Falls back to BGE Small (384 dims) if Nomic fails to load.
 *
 * No hosted APIs. Models are downloaded once and cached locally.
 */
import type { EmbeddingsProvider } from "./embeddings.js";

// Dynamic import so tests can mock without loading the heavy ONNX runtime.
let pipeline: any = null;
async function getPipeline(): Promise<any> {
  if (!pipeline) {
    const mod = await import("@xenova/transformers");
    pipeline = mod.pipeline;
  }
  return pipeline;
}

export type LocalModelId = "nomic-embed" | "bge-small";

export interface LocalEmbeddingsConfig {
  /** Which model to use. Default: "nomic-embed". */
  model?: LocalModelId;
}

const MODEL_CONFIGS: Record<LocalModelId, { name: string; dimensions: number }> = {
  "nomic-embed": {
    name: "nomic-ai/nomic-embed-text-v1.5",
    dimensions: 768,
  },
  "bge-small": {
    name: "BAAI/bge-small-en-v1.5",
    dimensions: 384,
  },
};

export class LocalEmbeddingsProvider implements EmbeddingsProvider {
  readonly dimensions: number;
  private modelName: string;
  private _extractor: any = null;
  private ready: Promise<void>;
  private _failed = false;

  constructor(config: LocalEmbeddingsConfig = {}) {
    const modelId = config.model ?? "nomic-embed";
    const cfg = MODEL_CONFIGS[modelId];
    this.modelName = cfg.name;
    this.dimensions = cfg.dimensions;

    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      const pipe = await getPipeline();
      this._extractor = await pipe("feature-extraction", this.modelName, {
        quantized: true,
      });
    } catch (err) {
      this._failed = true;
      throw new Error(
        `Failed to load local embedding model ${this.modelName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ready;
    const output = await this._extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    // output is a tensor; extract the float data
    const arr = output.data instanceof Float32Array
      ? output.data
      : new Float32Array(Object.values(output.data));
    return arr;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.ready;
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

/**
 * Detect the local git repository ID.
 * Returns undefined if not in a git repo.
 */
export function detectRepoId(cwd: string): string | undefined {
  // Try to read .git/config for origin URL to get a stable repo ID.
  const { execSync } = require("child_process") as typeof import("child_process");
  try {
    const origin = execSync("git config --get remote.origin.url", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (origin) {
      // Normalize: strip protocol, .git suffix, and trailing slash.
      return origin
        .replace(/^https?:\/\//, "")
        .replace(/\.git$/, "")
        .replace(/\/$/, "")
        .toLowerCase();
    }
  } catch {
    // Not a git repo or no origin.
  }
  return undefined;
}

/**
 * Detect the workspace root from the current directory.
 */
export function detectWorkspaceRoot(cwd: string): string {
  const { execSync } = require("child_process") as typeof import("child_process");
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return root;
  } catch {
    // Not a git repo.
  }
  return cwd;
}
