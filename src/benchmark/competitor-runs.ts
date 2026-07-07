import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CompetitorRunArtifact {
  source: "agentmemory" | "mem0" | "claude-mem";
  benchmark: string;
  artifact: string;
  metric: string;
  value: string;
  notes: string;
}

export async function loadCompetitorRunArtifacts(rootDirectory: string): Promise<CompetitorRunArtifact[]> {
  const root = resolve(rootDirectory);
  const runs: CompetitorRunArtifact[] = [];

  for (const mode of ["bm25", "hybrid"] as const) {
    const path = join(root, "agentmemory", "benchmark", "data", `longmemeval_results_${mode}.json`);
    const raw = await tryRead(path);
    if (!raw) continue;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    runs.push(...[
      ["recall_any_at_5", "R@5"],
      ["recall_any_at_10", "R@10"],
      ["recall_any_at_20", "R@20"],
      ["ndcg_at_10", "NDCG@10"],
      ["mrr", "MRR"],
    ].flatMap(([key, metric]) => {
      const value = parsed[key];
      return typeof value === "number" ? [{
        source: "agentmemory" as const,
        benchmark: `LongMemEval-S (${mode})`,
        artifact: path,
        metric,
        value: formatValue(value),
        notes: `questions=${stringOrNumber(parsed["questions"])}; mode=${mode}`,
      }] : [];
    }));
  }

  const mem0 = await tryRead(join(root, "mem0", "docs", "core-concepts", "memory-evaluation.mdx"));
  if (mem0) {
    runs.push(...extractMarkdownRuns("mem0", "memory-evaluation.mdx", mem0, [
      "LoCoMo",
      "LongMemEval",
      "BEAM (1M)",
      "BEAM (10M)",
    ]));
  }

  const claudeMem = await tryRead(join(root, "claude-mem", "docs", "public", "smart-explore-benchmark.mdx"));
  if (claudeMem) {
    runs.push(...extractClaudeMemRuns(claudeMem));
  }

  return runs;
}

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function extractMarkdownRuns(
  source: "mem0",
  artifactName: string,
  markdown: string,
  benchmarks: readonly string[],
): CompetitorRunArtifact[] {
  const runs: CompetitorRunArtifact[] = [];
  for (const benchmark of benchmarks) {
    const overall = benchmark === "BEAM (1M)" || benchmark === "BEAM (10M)"
      ? new RegExp(`\\|\\s+\\*\\*${escapeRegex(benchmark)}\\*\\*\\s+\\|\\s+\\*\\*([0-9.]+)\\*\\*\\s+\\|\\s+([0-9,]+)\\s+\\|`, "m")
      : new RegExp(`\\|\\s+\\*\\*${escapeRegex(benchmark)}\\*\\*\\s+\\|\\s+\\*\\*([0-9.]+)\\*\\*\\s+\\|\\s+([0-9,]+)\\s+\\|`, "m");
    const match = markdown.match(overall);
    if (!match) continue;
    runs.push({
      source,
      benchmark,
      artifact: artifactName,
      metric: "overall",
      value: match[1]!,
      notes: `avg_tokens_per_query=${match[2]}`,
    });
  }
  return runs;
}

function extractClaudeMemRuns(markdown: string): CompetitorRunArtifact[] {
  const runs: CompetitorRunArtifact[] = [];
  const rows = [
    ["Discovery (cross-file search)", "Discovery", "17.8x cheaper"],
    ["End-to-end (search + read)", "End-to-end", "10-12x cheaper"],
  ] as const;
  for (const [rowLabel, benchmark, metricLabel] of rows) {
    const pattern = new RegExp(`\\|\\s+${escapeRegex(rowLabel)}\\s+\\|\\s+([^|]+)\\s+\\|\\s+([^|]+)\\s+\\|\\s+\\*\\*([^|]+)\\*\\*\\s+\\|`, "m");
    const match = markdown.match(pattern);
    if (!match) continue;
    runs.push({
      source: "claude-mem",
      benchmark,
      artifact: "docs/public/smart-explore-benchmark.mdx",
      metric: "token_savings",
      value: metricLabel,
      notes: `smart=${trim(match[1])}; explore=${trim(match[2])}; advantage=${trim(match[3])}`,
    });
  }
  return runs;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trim(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function stringOrNumber(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "n/a";
}
