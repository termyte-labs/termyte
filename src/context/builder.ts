import type { Memory, Summary } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { HybridSearch, HybridSearchResult } from "../retrieval/hybrid.js";

export interface ContextInput {
  project: string;
  query?: string;
  maxMemories?: number;
}

export interface ContextOutput {
  memories: Memory[];
  summary: Summary | null;
  text: string;
}

/**
 * Render memories + a project summary into a human-readable block that
 * can be injected into a future agent's prompt.
 *
 * When `query` is provided, memories are returned from hybrid search
 * (FTS + vector) ranked by relevance. When `query` is absent, the
 * most-recent memories for the project are returned.
 */
export class ContextBuilder {
  constructor(private store: Store, private search: HybridSearch) {}

  async build(input: ContextInput): Promise<ContextOutput> {
    const limit = input.maxMemories ?? 50;
    let memories: Memory[];

    if (input.query) {
      const results = await this.search.search({
        query: input.query,
        project: input.project,
        limit,
      });
      memories = results.map((r) => r.memory);
    } else {
      memories = this.store.getRecentMemories(limit, input.project);
    }

    const summary = this.store.getMostRecentSummaryForProject(input.project);
    const text = renderContext(input.project, memories, summary);

    return { memories, summary, text };
  }
}

export function renderContext(
  project: string,
  memories: Memory[],
  summary: Summary | null,
): string {
  const lines: string[] = [];
  lines.push(`# Memory Context for ${project}`);
  lines.push("");

  if (summary) {
    lines.push("## Most recent summary");
    if (summary.request) lines.push(`- Request: ${summary.request}`);
    if (summary.investigated) lines.push(`- Investigated: ${summary.investigated}`);
    if (summary.learned) lines.push(`- Learned: ${summary.learned}`);
    if (summary.completed) lines.push(`- Completed: ${summary.completed}`);
    if (summary.next_steps) lines.push(`- Next steps: ${summary.next_steps}`);
    if (summary.notes) lines.push(`- Notes: ${summary.notes}`);
    lines.push("");
  }

  if (memories.length > 0) {
    lines.push(`## Memories (${memories.length})`);
    lines.push("");
    for (const m of memories) {
      lines.push(renderMemory(m));
      lines.push("");
    }
  } else {
    lines.push("## Memories");
    lines.push("");
    lines.push("(no memories yet)");
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function renderMemory(m: Memory): string {
  const parts: string[] = [];
  parts.push(`### [${m.type}] ${m.title}`);
  if (m.subtitle) parts.push(m.subtitle);
  if (m.narrative) parts.push(m.narrative);
  if (m.facts.length > 0) {
    parts.push("");
    parts.push(m.facts.map((f) => `- ${f}`).join("\n"));
  }
  if (m.concepts.length > 0) {
    parts.push("");
    parts.push(`Concepts: ${m.concepts.join(", ")}`);
  }
  if (m.files_read.length > 0) {
    parts.push("");
    parts.push(`Files read: ${m.files_read.join(", ")}`);
  }
  if (m.files_modified.length > 0) {
    parts.push("");
    parts.push(`Files modified: ${m.files_modified.join(", ")}`);
  }
  return parts.join("\n");
}

/** Re-export for callers that want to render HybridSearchResult[] directly. */
export function renderHybridResults(results: HybridSearchResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`#${r.memory.id} [${r.memory.type}] ${r.memory.title} (score: ${r.combined_score.toFixed(3)})`);
    if (r.memory.subtitle) lines.push(`  ${r.memory.subtitle}`);
    if (r.memory.narrative) {
      const first = r.memory.narrative.split("\n")[0] ?? "";
      if (first) lines.push(`  ${first.slice(0, 200)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
