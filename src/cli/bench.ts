import { resolve } from "node:path";
import { TermyteFtsBenchmarkAdapter } from "../benchmark/adapters/termyte-fts.js";
import { GrepBenchmarkAdapter } from "../benchmark/adapters/grep.js";
import { loadLongMemEval } from "../benchmark/datasets/longmemeval.js";
import { TermyteHybridBenchmarkAdapter } from "../benchmark/adapters/termyte-hybrid.js";
import { generateScaleDataset } from "../benchmark/datasets/scale.js";
import type { MemoryBenchmarkAdapter } from "../benchmark/types.js";
import { runBenchmark } from "../benchmark/runner.js";

export async function benchCommand(options: Record<string, string | boolean>): Promise<void> {
  const dataset = typeof options["dataset"] === "string" ? options["dataset"] : undefined;
  const track = options["track"] === "pipeline" ? "pipeline" : "retrieval";
  const adapterNames = (typeof options["adapter"] === "string" ? options["adapter"] : "fts")
    .split(",").map((value) => value.trim()).filter(Boolean);
  for (const adapter of adapterNames) {
    if (adapter !== "fts" && adapter !== "termyte" && adapter !== "grep") {
      throw new Error(`Adapter ${adapter} is not implemented. Available: grep, fts, termyte.`);
    }
  }
  const suite = typeof options["suite"] === "string" ? options["suite"] : "custom";
  if (suite !== "custom" && suite !== "longmemeval" && suite !== "scale") {
    throw new Error(`Suite ${suite} is not implemented. Available: custom, longmemeval, scale.`);
  }
  if (!dataset && suite !== "scale") throw new Error("bench run requires --dataset <path> unless --suite scale is used");
  const seed = typeof options["seed"] === "string" ? Number(options["seed"]) : 42;
  const output = typeof options["output"] === "string"
    ? options["output"]
    : resolve("benchmark-results", new Date().toISOString().replace(/[:.]/g, "-"));
  const generatedDataset = suite === "scale"
    ? generateScaleDataset(typeof options["size"] === "string" ? Number(options["size"]) : 1_000, seed)
    : undefined;
  const runs: Record<string, { output: string; metrics: Record<string, number> }> = {};
  for (const adapterName of adapterNames) {
    const runOutput = adapterNames.length === 1 ? output : resolve(output, adapterName);
    const metrics = await runBenchmark({
      datasetPath: suite === "scale" ? undefined : dataset,
      dataset: generatedDataset,
      outputDirectory: runOutput,
      adapter: createAdapter(adapterName, options),
      track,
      seed,
      datasetLoader: suite === "longmemeval" ? loadLongMemEval : undefined,
    });
    runs[adapterName] = { output: resolve(runOutput), metrics };
  }
  process.stdout.write(JSON.stringify({ runs }, null, 2) + "\n");
}

function createAdapter(name: string, options: Record<string, string | boolean>): MemoryBenchmarkAdapter {
  if (name === "grep") return new GrepBenchmarkAdapter();
  if (name === "termyte") {
    return new TermyteHybridBenchmarkAdapter(
      options["embedding-model"] === "nomic-embed" ? "nomic-embed" : "bge-small",
    );
  }
  return new TermyteFtsBenchmarkAdapter();
}
