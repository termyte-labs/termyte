import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CompetitorExecutionAdapter {
  source: "agentmemory" | "mem0" | "claude-mem";
  repository: string;
  executable: boolean;
  commands: string[];
  publicArtifacts: string[];
  notes: string;
}

export async function loadCompetitorExecutionAdapters(rootDirectory: string): Promise<CompetitorExecutionAdapter[]> {
  const root = resolve(rootDirectory);
  const adapters: CompetitorExecutionAdapter[] = [];

  if (await exists(join(root, "agentmemory", "package.json"))) {
    adapters.push({
      source: "agentmemory",
      repository: join(root, "agentmemory"),
      executable: true,
      commands: [
        "npm run bench:longmemeval [bm25|vector|hybrid]",
        "npm run bench:quality",
        "npm run bench:scale",
        "npm run bench:real-embeddings",
      ],
      publicArtifacts: [
        "benchmark/results/load-100k-*.json",
        "benchmark/LONGMEMEVAL.md",
        "benchmark/QUALITY.md",
        "benchmark/REAL-EMBEDDINGS.md",
        "benchmark/SCALE.md",
      ],
      notes: "Node-based benchmark scripts are present in the local checkout.",
    });
  }

  if (await exists(join(root, "mem0", "pyproject.toml"))) {
    adapters.push({
      source: "mem0",
      repository: join(root, "mem0"),
      executable: true,
      commands: [
        "python -m benchmarks.locomo.run --project-name <name> --top-k 200",
        "python -m benchmarks.longmemeval.run --project-name <name> --all-questions --top-k 200",
        "python -m benchmarks.beam.run --project-name <name> --chat-sizes 1M|10M --conversations 0-99 --top-k 200",
      ],
      publicArtifacts: [
        "results/[benchmark]/",
        "docs/core-concepts/memory-evaluation.mdx",
      ],
      notes: "The public evaluation framework is documented in the local checkout; Termyte can compare published outputs and mirror the runner contract.",
    });
  }

  if (await exists(join(root, "claude-mem", "package.json"))) {
    adapters.push({
      source: "claude-mem",
      repository: join(root, "claude-mem"),
      executable: false,
      commands: [],
      publicArtifacts: [
        "docs/public/smart-explore-benchmark.mdx",
      ],
      notes: "No standalone benchmark runner was found in the local checkout; only the published Smart Explore report is machine-readable here.",
    });
  }

  return adapters;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
