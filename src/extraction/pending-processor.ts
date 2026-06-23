import type Database from "better-sqlite3";
import type { GeminiClient } from "./gemini.js";
import type { PendingMessage } from "../types.js";
import { parseXml } from "./parser.js";
import { classifyOutput } from "./output-classifier.js";
import { ResponseProcessor } from "./response-processor.js";

export interface PendingProcessorOptions {
  batchSize?: number;
  agentType?: string;
  agentId?: string;
}

export interface ProcessResult {
  processed: number;
  stored: number;
  skipped: number;
  errors: number;
}

interface PendingMessageRow {
  id: number;
  session_db_id: number;
  content_session_id: string;
  tool_use_id: string | null;
  message_type: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_user_message: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  status: string;
  created_at_epoch: number;
  agent_type: string | null;
  agent_id: string | null;
  memory_session_id: string;
  project: string;
}

export class PendingProcessor {
  constructor(
    private db: Database.Database,
    private gemini: GeminiClient,
    private workspaceRoot: string,
  ) {}

  async processPending(options: PendingProcessorOptions = {}): Promise<ProcessResult> {
    const batchSize = options.batchSize ?? 10;
    const result: ProcessResult = { processed: 0, stored: 0, skipped: 0, errors: 0 };

    const pending = this.db.prepare(`
      SELECT pm.*, s.memory_session_id, s.project
      FROM pending_messages pm
      JOIN sessions s ON s.id = pm.session_db_id
      WHERE pm.status = 'pending' AND pm.message_type = 'observation'
      ORDER BY pm.created_at_epoch ASC
      LIMIT ?
    `).all(batchSize) as PendingMessageRow[];

    if (pending.length === 0) return result;

    for (const msg of pending) {
      try {
        await this.processOne(msg, options);
        result.processed++;
      } catch (err) {
        result.errors++;
      }
    }

    return result;
  }

  private async processOne(
    msg: PendingMessageRow,
    options: PendingProcessorOptions,
  ): Promise<void> {
    this.db.prepare("UPDATE pending_messages SET status = 'processing' WHERE id = ?").run(msg.id);

    const llmOutput = await this.gemini.observeToolUse(
      msg.tool_name ?? "unknown",
      msg.tool_input ? JSON.parse(msg.tool_input) : null,
      msg.tool_response ? JSON.parse(msg.tool_response) : null,
      msg.last_user_message ?? undefined,
    );

    const outputClass = classifyOutput(llmOutput);
    if (outputClass !== "xml") {
      this.db.prepare("DELETE FROM pending_messages WHERE id = ?").run(msg.id);
      return;
    }

    const parsed = parseXml(llmOutput);
    if (!parsed.valid || parsed.observations.length === 0) {
      this.db.prepare("DELETE FROM pending_messages WHERE id = ?").run(msg.id);
      return;
    }

    const processor = new ResponseProcessor({
      db: this.db,
      workspaceRoot: this.workspaceRoot,
      agentType: options.agentType ?? msg.agent_type ?? undefined,
      agentId: options.agentId ?? msg.agent_id ?? undefined,
    });

    const stored = await processor.processObservations({
      db: this.db,
      workspaceRoot: this.workspaceRoot,
      contentSessionId: msg.content_session_id,
      observations: parsed.observations,
      summary: parsed.summary ?? undefined,
      generatedByModel: "gemini-2.5-flash",
      agentType: options.agentType ?? msg.agent_type ?? undefined,
      agentId: options.agentId ?? msg.agent_id ?? undefined,
    });

    this.db.prepare("DELETE FROM pending_messages WHERE id = ?").run(msg.id);
  }
}
