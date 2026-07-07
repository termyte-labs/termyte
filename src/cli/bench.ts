import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { TermyteFtsBenchmarkAdapter } from "../benchmark/adapters/termyte-fts.js";
import { GrepBenchmarkAdapter } from "../benchmark/adapters/grep.js";
import { compareBenchmarkRuns } from "../benchmark/comparison.js";
import { loadLoCoMoDataset } from "../benchmark/datasets/locomo.js";
import { loadMemoryAgentBenchDataset } from "../benchmark/datasets/memoryagentbench.js";
import { loadLongMemEval } from "../benchmark/datasets/longmemeval.js";
import { loadRawSessionDataset } from "../benchmark/datasets/raw-session.js";
import { TermyteHybridBenchmarkAdapter } from "../benchmark/adapters/termyte-hybrid.js";
import { TermytePipelineBenchmarkAdapter } from "../benchmark/adapters/termyte-pipeline.js";
import { generateScaleDataset } from "../benchmark/datasets/scale.js";
import { runCompetitorBenchmark } from "../benchmark/competitor-executions.js";
import type { MemoryBenchmarkAdapter } from "../benchmark/types.js";
import { runBenchmark } from "../benchmark/runner.js";

export async function benchCommand(options: Record<string, string | boolean>): Promise<void> {
  const mode = typeof options["mode"] === "string" ? options["mode"] : "run";
  if (mode === "competitor") {
    const source = typeof options["source"] === "string" ? options["source"] : undefined;
    const benchmark = typeof options["benchmark"] === "string" ? options["benchmark"] : undefined;
    if (!source || !benchmark) {
      throw new Error("bench competitor requires --source agentmemory|mem0|claude-mem and --benchmark <name>");
    }
    const result = await runCompetitorBenchmark({
      source: source as "agentmemory" | "mem0" | "claude-mem",
      benchmark: benchmark as "longmemeval" | "quality" | "scale" | "real-embeddings" | "load-100k" | "locomo" | "beam",
      rootDirectory: typeof options["competitor-root"] === "string"
        ? options["competitor-root"]
        : resolve(process.cwd(), "..", "competitors"),
      mode: typeof options["benchmark-mode"] === "string" ? options["benchmark-mode"] as "bm25" | "vector" | "hybrid" : undefined,
      projectName: typeof options["project-name"] === "string" ? options["project-name"] : undefined,
      backend: typeof options["backend"] === "string" ? options["backend"] as "oss" | "cloud" : undefined,
      mem0ApiKey: typeof options["mem0-api-key"] === "string" ? options["mem0-api-key"] : undefined,
      mem0Host: typeof options["mem0-host"] === "string" ? options["mem0-host"] : undefined,
      dryRun: options["dry-run"] === true,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (mode === "compare") {
    const runs = typeof options["runs"] === "string"
      ? options["runs"].split(",").map((value) => value.trim()).filter(Boolean)
      : [];
    if (runs.length < 2) throw new Error("bench compare requires --runs dir1,dir2,...");
    const output = typeof options["output"] === "string"
      ? options["output"]
      : resolve("benchmark-comparisons", new Date().toISOString().replace(/[:.]/g, "-"));
    const competitorRoot = typeof options["competitor-root"] === "string"
      ? options["competitor-root"]
      : existsSync(resolve(process.cwd(), "..", "competitors"))
        ? resolve(process.cwd(), "..", "competitors")
        : undefined;
    const result = await compareBenchmarkRuns(runs, output, competitorRoot);
    process.stdout.write(JSON.stringify({ output: resolve(output), runs: result.runs.length }, null, 2) + "\n");
    return;
  }

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
  if (suite !== "custom" && suite !== "locomo" && suite !== "longmemeval" && suite !== "memoryagent" && suite !== "raw-session" && suite !== "scale") {
    throw new Error(`Suite ${suite} is not implemented. Available: custom, locomo, longmemeval, memoryagent, raw-session, scale.`);
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
      adapter: createAdapter(adapterName, track, options),
      track,
      seed,
      datasetLoader: suite === "locomo" ? loadLoCoMoDataset : suite === "memoryagent" ? loadMemoryAgentBenchDataset : suite === "longmemeval" ? loadLongMemEval : suite === "raw-session" ? loadRawSessionDataset : undefined,
    });
    runs[adapterName] = { output: resolve(runOutput), metrics };
  }
  process.stdout.write(JSON.stringify({ runs }, null, 2) + "\n");
}

function createAdapter(name: string, track: "retrieval" | "pipeline", options: Record<string, string | boolean>): MemoryBenchmarkAdapter {
  if (name === "grep") return new GrepBenchmarkAdapter();
  if (name === "termyte") {
    if (track === "pipeline") return new TermytePipelineBenchmarkAdapter();
    return new TermyteHybridBenchmarkAdapter(
      options["embedding-model"] === "nomic-embed" ? "nomic-embed" : "bge-small",
    );
  }
  return new TermyteFtsBenchmarkAdapter();
}
