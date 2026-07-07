import type { BenchmarkDataset, BenchmarkDocument, BenchmarkQuery } from "../types.js";

interface LoCoMoTurn {
  speaker?: string;
  dia_id?: string | number;
  text?: string;
  img_url?: string;
  blip_caption?: string;
  image_query?: string;
}

interface LoCoMoSession {
  [key: string]: unknown;
}

interface LoCoMoRow {
  sample_id: string;
  conversation: LoCoMoSession[] | Record<string, unknown>;
  qa?: Array<{
    question?: string;
    answer?: string;
    category?: string;
    evidence?: Array<string | number>;
  }>;
}

export function loadLoCoMoDataset(raw: string, limit?: number): BenchmarkDataset {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LoCoMo dataset must be a JSON array.");
  const rows = (parsed as LoCoMoRow[]).slice(0, limit);
  const documents: BenchmarkDocument[] = [];
  const queries: BenchmarkQuery[] = [];

  for (const row of rows) {
    if (!row.sample_id || row.conversation == null) {
      throw new Error("Invalid LoCoMo row: missing sample_id or conversation.");
    }

    const diaToDocument = new Map<string, string>();
    const sessions = extractSessions(row.conversation);
    sessions.forEach((session, sessionIndex) => {
      session.turns.forEach((turn, turnIndex) => {
        const documentId = `${row.sample_id}::${session.sessionId}::turn_${turnIndex.toString().padStart(3, "0")}`;
        documents.push({
          id: documentId,
          scope: row.sample_id,
          title: `${row.sample_id} ${session.sessionId} turn ${turnIndex + 1}`,
          content: turn.text ? `[${turn.speaker ?? "speaker"}] ${turn.text}` : "",
          metadata: {
            sessionIndex,
            sessionId: session.sessionId,
            speakerA: session.speakerA ?? null,
            speakerB: session.speakerB ?? null,
            dateTime: session.dateTime ?? null,
            diaId: turn.dia_id ?? null,
            imageUrl: turn.img_url ?? null,
            blipCaption: turn.blip_caption ?? null,
            imageQuery: turn.image_query ?? null,
          },
        });
        if (turn.dia_id != null) diaToDocument.set(String(turn.dia_id), documentId);
      });
    });

    row.qa?.forEach((qa, index) => {
      if (!qa.question) throw new Error(`Invalid LoCoMo qa item in sample ${row.sample_id}.`);
      queries.push({
        id: `${row.sample_id}::qa_${index.toString().padStart(3, "0")}`,
        scope: row.sample_id,
        query: qa.question,
        relevantDocumentIds: (qa.evidence ?? []).flatMap((evidence) => {
          const documentId = diaToDocument.get(String(evidence));
          return documentId ? [documentId] : [];
        }),
      });
    });
  }

  return {
    name: "LoCoMo",
    version: "source",
    suite: "locomo",
    documents,
    queries,
  };
}

function extractSessions(conversation: LoCoMoRow["conversation"]): Array<{
  sessionId: string;
  speakerA?: string;
  speakerB?: string;
  dateTime?: string;
  turns: LoCoMoTurn[];
}> {
  if (Array.isArray(conversation)) {
    return conversation.flatMap((entry, index) => {
      const sessionKey = `session_${index + 1}`;
      const turns = extractTurns(entry);
      return turns.length > 0 ? [{
        sessionId: sessionKey,
        speakerA: readString(entry, "speaker_a"),
        speakerB: readString(entry, "speaker_b"),
        dateTime: readString(entry, `${sessionKey}_date_time`) ?? readString(entry, "date_time"),
        turns,
      }] : [];
    });
  }

  return Object.entries(conversation)
    .filter(([key, value]) => /^session_\d+$/.test(key) && value != null)
    .flatMap(([key, value]) => {
      const turns = extractTurns(value);
      return turns.length > 0 ? [{
        sessionId: key,
        speakerA: readString(conversation, "speaker_a"),
        speakerB: readString(conversation, "speaker_b"),
        dateTime: readString(conversation, `${key}_date_time`) ?? readString(conversation, "date_time"),
        turns,
      }] : [];
    });
}

function extractTurns(value: unknown): LoCoMoTurn[] {
  if (Array.isArray(value)) return value.filter((turn): turn is LoCoMoTurn => !!turn && typeof turn === "object");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["turns", "dialog", "dialogs", "conversation", "utterances"]) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate.filter((turn): turn is LoCoMoTurn => !!turn && typeof turn === "object");
    }
  }
  return [];
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const raw = record[key];
  return typeof raw === "string" ? raw : undefined;
}
