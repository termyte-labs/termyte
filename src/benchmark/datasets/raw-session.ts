import type { BenchmarkDataset, BenchmarkDocument, BenchmarkQuery } from "../types.js";

interface RawSessionRow {
  session_id: string;
  project?: string;
  turns: Array<{
    role: string;
    content: string;
    files?: string[];
    relevant?: boolean;
  }>;
  queries: Array<{
    id: string;
    query: string;
    relevant_turn_indexes: number[];
    harmful_turn_indexes?: number[];
  }>;
}

/**
 * Convert a raw session transcript corpus into benchmark documents and
 * query labels. Each turn becomes a candidate document, and query labels can
 * refer back to the turns that matter.
 */
export function loadRawSessionDataset(raw: string, limit?: number): BenchmarkDataset {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Raw session dataset must be a JSON array.");

  const rows = (parsed as RawSessionRow[]).slice(0, limit);
  const documents: BenchmarkDocument[] = [];
  const queries: BenchmarkQuery[] = [];

  for (const row of rows) {
    if (!row.session_id || !Array.isArray(row.turns) || !Array.isArray(row.queries)) {
      throw new Error("Invalid raw session row: missing session_id, turns, or queries.");
    }

    const scopedId = (turnIndex: number): string => `${row.session_id}::turn_${turnIndex.toString().padStart(3, "0")}`;
    row.turns.forEach((turn, index) => {
      documents.push({
        id: scopedId(index),
        scope: row.session_id,
        title: `${row.session_id} turn ${index + 1}`,
        content: `[${turn.role}] ${turn.content}`,
        files: turn.files ?? [],
        metadata: {
          project: row.project ?? null,
          turnIndex: index,
          relevant: turn.relevant ?? false,
        },
      });
    });

    for (const query of row.queries) {
      if (!query.id || !query.query || !Array.isArray(query.relevant_turn_indexes)) {
        throw new Error(`Invalid raw session query in session ${row.session_id}.`);
      }
      queries.push({
        id: query.id,
        scope: row.session_id,
        query: query.query,
        relevantDocumentIds: query.relevant_turn_indexes.map(scopedId),
        harmfulDocumentIds: (query.harmful_turn_indexes ?? []).map(scopedId),
      });
    }
  }

  return {
    name: "Raw session pipeline",
    version: "source",
    suite: "raw-session",
    documents,
    queries,
  };
}
