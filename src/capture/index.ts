import type Database from "better-sqlite3";
import type { Session, Observation, PlatformSource, SessionStatus } from "../types.js";
import { nowISO } from "../utils.js";
import { SessionStore } from "../hook-system/session-store.js";

export class CaptureEngine {
  private sessionStore: SessionStore;

  constructor(private readonly db: Database.Database) {
    this.sessionStore = new SessionStore(db);
  }

  startSession(
    project: string,
    platformSource: PlatformSource = "termyte",
    userPrompt?: string,
    contentSessionId?: string,
  ): Session {
    return this.sessionStore.createSession({
      contentSessionId,
      project,
      platformSource,
      userPrompt,
    });
  }

  endSession(contentSessionId: string, status: SessionStatus = "completed"): void {
    const now = nowISO();
    const nowEpoch = Date.now();
    this.db.prepare(
      "UPDATE sessions SET status = ?, completed_at = ?, completed_at_epoch = ? WHERE content_session_id = ?"
    ).run(status, now, nowEpoch, contentSessionId);
  }

  getObservations(memorySessionId: string): Observation[] {
    const rows = this.db.prepare(
      "SELECT * FROM observations WHERE memory_session_id = ? ORDER BY created_at_epoch ASC"
    ).all(memorySessionId) as any[];
    return rows.map(this.rowToObservation);
  }

  getSession(contentSessionId: string): Session | null {
    return this.sessionStore.getSessionByContentId(contentSessionId);
  }

  listSessions(limit = 20, project?: string): Session[] {
    return this.sessionStore.listSessions({ limit, project });
  }

  private rowToObservation(row: any): Observation {
    return {
      id: row.id,
      memorySessionId: row.memory_session_id,
      project: row.project,
      text: row.text,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      facts: row.facts,
      narrative: row.narrative,
      concepts: row.concepts,
      filesRead: row.files_read,
      filesModified: row.files_modified,
      promptNumber: row.prompt_number,
      discoveryTokens: row.discovery_tokens,
      contentHash: row.content_hash,
      agentType: row.agent_type,
      agentId: row.agent_id,
      generatedByModel: row.generated_by_model,
      relevanceCount: row.relevance_count,
      metadata: row.metadata,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
    };
  }
}
