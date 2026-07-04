import type { BenchmarkDataset, BenchmarkDocument, BenchmarkQuery } from "../types.js";

interface LongMemEvalRow {
  question_id: string;
  question_type: string;
  question: string;
  answer?: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

export function loadLongMemEval(raw: string, limit?: number): BenchmarkDataset {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LongMemEval dataset must be a JSON array.");
  const rows = (parsed as LongMemEvalRow[]).slice(0, limit);
  const documents: BenchmarkDocument[] = [];
  const queries: BenchmarkQuery[] = [];
  for (const row of rows) {
    if (!row.question_id || !row.question || !Array.isArray(row.answer_session_ids)) {
      throw new Error("Invalid LongMemEval row: missing question fields.");
    }
    if (row.haystack_session_ids.length !== row.haystack_sessions.length) {
      throw new Error(`LongMemEval row ${row.question_id}: session ID/content length mismatch.`);
    }
    const scopedId = (sessionId: string): string => `${row.question_id}::${sessionId}`;
    row.haystack_session_ids.forEach((sessionId, index) => {
      const turns = row.haystack_sessions[index];
      if (!turns) throw new Error(`LongMemEval row ${row.question_id}: missing session ${sessionId}.`);
      documents.push({
        id: scopedId(sessionId),
        scope: row.question_id,
        title: `Session ${sessionId}`,
        content: turns.map((turn) => `[${turn.role}] ${turn.content}`).join("\n\n"),
        metadata: { questionType: row.question_type, sourceSessionId: sessionId },
      });
    });
    queries.push({
      id: row.question_id,
      scope: row.question_id,
      query: row.question,
      relevantDocumentIds: row.answer_session_ids.map(scopedId),
    });
  }
  return { name: "LongMemEval-S", version: "source", suite: "longmemeval", documents, queries };
}

