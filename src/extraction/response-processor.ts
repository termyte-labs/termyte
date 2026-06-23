import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NormalizedHookInput, Observation, PendingMessage, UserPrompt, ObservationType } from "../types.js";
import { nowISO, fingerprint } from "../utils.js";
import { getAdapter, detectPlatform } from "../hook-system/adapters.js";

export interface ResponseProcessorInput {
  db: Database.Database;
  workspaceRoot: string;
  agentType?: string;
  agentId?: string;
}

export interface ProcessObservationInput {
  db: Database.Database;
  workspaceRoot: string;
  contentSessionId: string;
  observations: any[];
  summary?: any;
  generatedByModel?: string;
  agentType?: string;
  agentId?: string;
}

export class ResponseProcessor {
  constructor(private ctx: ResponseProcessorInput) {}

  async processToolUse(hookInput: NormalizedHookInput): Promise<{ pendingMessageId: number } | null> {
    const session = this.ctx.db.prepare(
      "SELECT * FROM sessions WHERE content_session_id = ?"
    ).get(hookInput.sessionId) as any;

    if (!session) {
      return null;
    }

    const insertPending = this.ctx.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, tool_use_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_user_message, last_assistant_message, prompt_number,
        status, created_at_epoch, agent_type, agent_id
      ) VALUES (?, ?, ?, 'observation', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    const result = insertPending.run(
      session.id,
      hookInput.sessionId,
      hookInput.turnId ?? null,
      hookInput.toolName ?? null,
      hookInput.toolInput ? JSON.stringify(hookInput.toolInput) : null,
      hookInput.toolResponse ? JSON.stringify(hookInput.toolResponse) : null,
      hookInput.cwd ?? null,
      hookInput.prompt ?? null,
      hookInput.lastAssistantMessage ?? null,
      session.prompt_counter ?? 0,
      Date.now(),
      this.ctx.agentType ?? hookInput.agentType ?? null,
      this.ctx.agentId ?? hookInput.agentId ?? null,
    );

    return { pendingMessageId: Number(result.lastInsertRowid) };
  }

  async processUserPrompt(hookInput: NormalizedHookInput): Promise<void> {
    const session = this.ctx.db.prepare(
      "SELECT * FROM sessions WHERE content_session_id = ?"
    ).get(hookInput.sessionId) as any;

    if (!session) return;

    const newPromptCount = (session.prompt_counter ?? 0) + 1;
    this.ctx.db.prepare(
      "UPDATE sessions SET prompt_counter = ? WHERE content_session_id = ?"
    ).run(newPromptCount, hookInput.sessionId);

    if (hookInput.prompt) {
      this.ctx.db.prepare(`
        INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run(hookInput.sessionId, newPromptCount, hookInput.prompt, nowISO(), Date.now());
    }
  }

  async processObservations(input: ProcessObservationInput): Promise<Observation[]> {
    const { db, workspaceRoot, observations, summary, generatedByModel, agentType, agentId } = input;
    const contentSessionId = input.contentSessionId;

    const session = db.prepare(
      "SELECT * FROM sessions WHERE content_session_id = ?"
    ).get(contentSessionId) as any;

    if (!session) return [];

    const project = workspaceRoot.split(/[\\/]/).pop() ?? "unknown";
    const now = nowISO();
    const nowEpoch = Date.now();

    const inserted: Observation[] = [];
    const insertObs = db.prepare(`
      INSERT OR IGNORE INTO observations (
        memory_session_id, project, text, type, title, subtitle, facts, narrative,
        concepts, files_read, files_modified, prompt_number, discovery_tokens,
        content_hash, agent_type, agent_id, generated_by_model, relevance_count,
        metadata, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `);

    const upsertFts = db.prepare(`
      INSERT OR REPLACE INTO observations_fts (rowid, title, subtitle, narrative, text, facts, concepts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const obs of observations) {
      const contentHash = fingerprint(
        `${session.memory_session_id}:${obs.type}:${obs.title ?? ""}:${(obs.facts ?? []).join(",")}`
      );

      const result = insertObs.run(
        session.memory_session_id,
        project,
        JSON.stringify(obs),
        obs.type ?? "discovery",
        obs.title ?? null,
        obs.subtitle ?? null,
        obs.facts ? JSON.stringify(obs.facts) : null,
        obs.narrative ?? null,
        obs.concepts ? JSON.stringify(obs.concepts) : null,
        obs.files_read ? JSON.stringify(obs.files_read) : null,
        obs.files_modified ? JSON.stringify(obs.files_modified) : null,
        session.prompt_counter ?? 0,
        0,
        contentHash,
        agentType ?? null,
        agentId ?? null,
        generatedByModel ?? null,
        JSON.stringify({}),
        now,
        nowEpoch,
      );

      if (result.changes > 0) {
        const obsId = Number(result.lastInsertRowid);
        upsertFts.run(
          obsId,
          obs.title ?? "",
          obs.subtitle ?? "",
          obs.narrative ?? "",
          JSON.stringify(obs),
          obs.facts ? JSON.stringify(obs.facts) : "",
          obs.concepts ? JSON.stringify(obs.concepts) : "",
        );
        inserted.push({
          id: obsId,
          memorySessionId: session.memory_session_id,
          project,
          text: JSON.stringify(obs),
          type: obs.type ?? "discovery",
          title: obs.title,
          subtitle: obs.subtitle,
          facts: obs.facts ? JSON.stringify(obs.facts) : undefined,
          narrative: obs.narrative,
          concepts: obs.concepts ? JSON.stringify(obs.concepts) : undefined,
          filesRead: obs.files_read ? JSON.stringify(obs.files_read) : undefined,
          filesModified: obs.files_modified ? JSON.stringify(obs.files_modified) : undefined,
          promptNumber: session.prompt_counter,
          discoveryTokens: 0,
          contentHash,
          agentType,
          agentId,
          generatedByModel,
          relevanceCount: 0,
          metadata: JSON.stringify({}),
          createdAt: now,
          createdAtEpoch: nowEpoch,
        });
      }
    }

    return inserted;
  }

  async processSessionEnd(contentSessionId: string): Promise<void> {
    const now = nowISO();
    const nowEpoch = Date.now();
    this.ctx.db.prepare(
      "UPDATE sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ? WHERE content_session_id = ?"
    ).run(now, nowEpoch, contentSessionId);
  }
}
