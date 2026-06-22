import type { Memory, MemoryWithScore } from "../types.js";

export interface InjectedContext {
  header: string;
  memories: MemoryWithScore[];
  body: string;
}

export function buildInjectionContext(
  memories: MemoryWithScore[],
  task: string,
): InjectedContext {
  if (memories.length === 0) {
    return {
      header: `No relevant memories found for: ${task}`,
      memories: [],
      body: "",
    };
  }

  const lines: string[] = [];
  lines.push(`Relevant memories for: ${task}`);
  lines.push("");

  for (const [i, mem] of memories.entries()) {
    const confidence = `${(mem.confidence * 100).toFixed(0)}%`;
    const stats = `${mem.successCount} successes, ${mem.failureCount} failures`;
    lines.push(`[${i + 1}] (${mem.type}, confidence: ${confidence}, ${stats})`);
    lines.push(`    ${mem.claim}`);
    if (mem.language) lines.push(`    Language: ${mem.language}`);
    if (mem.astAnchors && mem.astAnchors.length > 0) {
      const anchors = mem.astAnchors.map((a) => `${a.name}(${a.kind})`).join(", ");
      lines.push(`    Code locations: ${anchors}`);
    }
    lines.push(`    Matched: ${mem.matchedBecause}`);
    lines.push("");
  }

  return {
    header: `Termyte Memory Context (${memories.length} memories)`,
    memories,
    body: lines.join("\n"),
  };
}

export function formatForAgent(injected: InjectedContext): string {
  if (injected.memories.length === 0) return "";
  return [
    `<termyte_memory>`,
    injected.body,
    `</termyte_memory>`,
  ].join("\n");
}
