import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PublishedBaseline {
  source: "agentmemory" | "mem0" | "claude-mem";
  benchmark: string;
  label: string;
  score: string;
  notes: string;
}

export async function loadPublishedBaselines(rootDirectory: string): Promise<PublishedBaseline[]> {
  const root = resolve(rootDirectory);
  const baselines: PublishedBaseline[] = [];

  const mem0 = await tryRead(join(root, "mem0", "docs", "core-concepts", "memory-evaluation.mdx"));
  if (mem0) {
    for (const [benchmark, pattern] of [
      ["BEAM (1M)", /\|\s+\*\*BEAM \(1M\)\*\*\s+\|\s+\*\*([0-9.]+)\*\*\s+\|\s+([0-9,]+)\s+\|/m],
      ["BEAM (10M)", /\|\s+\*\*BEAM \(10M\)\*\*\s+\|\s+\*\*([0-9.]+)\*\*\s+\|\s+([0-9,]+)\s+\|/m],
    ] as const) {
      const match = matchTableRow(mem0, pattern);
      if (match) {
        baselines.push({
          source: "mem0",
          benchmark,
          label: benchmark,
          score: match[1],
          notes: `${match[2]} avg tokens/query`,
        });
      }
    }
  }

  const claudeMem = await tryRead(join(root, "claude-mem", "docs", "public", "smart-explore-benchmark.mdx"));
  if (claudeMem) {
    const discovery = matchTableRow(claudeMem, /^\|\s+Discovery \(cross-file search\)\s+\|\s+([^|]+)\s+\|\s+([^|]+)\s+\|\s+\*\*([^|]+)\*\*\s+\|/m);
    const endToEnd = matchTableRow(claudeMem, /^\|\s+End-to-end \(search \+ read\)\s+\|\s+([^|]+)\s+\|\s+([^|]+)\s+\|\s+\*\*([^|]+)\*\*\s+\|/m);
    if (discovery) {
      baselines.push({
        source: "claude-mem",
        benchmark: "Smart Explore",
        label: "Discovery",
        score: `${trimCell(discovery[1])} vs ${trimCell(discovery[2])}`,
        notes: trimCell(discovery[3]),
      });
    }
    if (endToEnd) {
      baselines.push({
        source: "claude-mem",
        benchmark: "Smart Explore",
        label: "End-to-end",
        score: `${trimCell(endToEnd[1])} vs ${trimCell(endToEnd[2])}`,
        notes: trimCell(endToEnd[3]),
      });
    }
  }

  return baselines;
}

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function matchTableRow(text: string, pattern: RegExp): RegExpMatchArray | null {
  return text.match(pattern);
}

function trimCell(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}
