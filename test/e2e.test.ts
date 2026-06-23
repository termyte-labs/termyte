import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, closeDatabase } from "../src/db.js";
import { CaptureEngine } from "../src/capture/index.js";
import { createMemoryEngine } from "../src/memory/index.js";
import { recordOutcomeAndFeedback } from "../src/memory/outcome.js";
import { createRetrievalEngine } from "../src/retrieval/index.js";
import { SessionStore } from "../src/hook-system/session-store.js";
import { ResponseProcessor } from "../src/extraction/response-processor.js";
import { PendingProcessor } from "../src/extraction/pending-processor.js";
import { OpenCodeAdapter } from "../src/hook-system/adapters.js";
import { createFakeGemini } from "./fake-gemini.js";
import type { NormalizedHookInput } from "../src/types.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-e2e-"));
  dbPath = path.join(tmpDir, ".termyte", "termyte.db");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("E2E: hook -> pending -> observations -> memories -> retrieval -> outcome", () => {
  it("completes the full MVP loop", async () => {
    const { db } = openDatabase(dbPath);
    const fake = createFakeGemini();
    const project = "e2e-project";
    const sessionId = "e2e-session-001";

    // Step 1: start a session
    const capture = new CaptureEngine(db);
    const session = capture.startSession(project, "opencode", "fix auth bug", sessionId);
    expect(session.contentSessionId).toBe(sessionId);
    expect(session.platformSource).toBe("opencode");

    // Step 2: simulate an OpenCode tool.execute.after event
    const rawEvent = {
      platform: "opencode",
      event: "tool.execute.after",
      sessionId,
      cwd: tmpDir,
      input: { tool: "read" },
      output: {
        tool: "read",
        args: { filePath: "src/auth.ts" },
        result: "export function authenticate(token) { return token === 'admin'; }",
        exitCode: 0,
      },
    };

    const adapter = new OpenCodeAdapter();
    const normalized: NormalizedHookInput = adapter.normalizeInput(rawEvent);
    expect(normalized.platform).toBe("opencode");
    expect(normalized.hookEvent).toBe("tool_use");
    expect(normalized.toolName).toBe("read");
    expect(normalized.toolInput).toEqual({ filePath: "src/auth.ts" });
    expect(normalized.commandExitCode).toBe(0);

    // Step 3: enqueue a pending message
    const responseProcessor = new ResponseProcessor({ db, workspaceRoot: tmpDir });
    const result = await responseProcessor.processToolUse(normalized);
    expect(result).not.toBeNull();
    expect(result!.pendingMessageId).toBeGreaterThan(0);

    const pendingCount = (db.prepare("SELECT COUNT(*) as c FROM pending_messages").get() as { c: number }).c;
    expect(pendingCount).toBe(1);

    // Step 4: process pending -> observations
    const pendingProcessor = new PendingProcessor(db, fake, tmpDir);
    const processResult = await pendingProcessor.processPending({ batchSize: 5 });
    expect(processResult.processed).toBe(1);
    expect(processResult.stored).toBe(1);
    expect(processResult.errors).toBe(0);

    const observationRows = db.prepare("SELECT * FROM observations").all() as any[];
    expect(observationRows).toHaveLength(1);
    expect(observationRows[0].type).toBe("discovery");
    expect(observationRows[0].title).toBe("Read source file");
    expect(observationRows[0].memory_session_id).toBe(session.memorySessionId);

    const pendingAfter = (db.prepare("SELECT COUNT(*) as c FROM pending_messages").get() as { c: number }).c;
    expect(pendingAfter).toBe(0);

    expect(fake.observeToolUseCalls).toHaveLength(1);
    expect(fake.observeToolUseCalls[0].toolName).toBe("read");

    // Step 5: create memories (skipping the LLM extraction step and using
    // the pre-canned extracted memories the fake would have produced)
    const memoryEngine = createMemoryEngine(db);
    const createdMemories = fake.extractMemoriesCalls.length > 0
      ? []
      : [];
    void createdMemories;

    const trace = buildTraceFromObservations(observationRows);
    const extracted = await fake.extractMemories(trace, project);
    const storedMemories = extracted.map((m) =>
      memoryEngine.createMemory({
        claim: m.claim,
        type: m.type,
        repoScope: project,
        language: m.language,
        sources: observationRows.map((o) => String(o.id)),
      })
    );
    expect(storedMemories).toHaveLength(2);

    // Step 6: retrieval - search and inject
    const retrieval = createRetrievalEngine(db, fake);
    const search = await retrieval.search("auth token rotation");
    expect(search.memories.length).toBeGreaterThan(0);
    const top = search.memories[0];
    expect(top.claim.toLowerCase()).toContain("auth");

    const injected = await retrieval.inject("fix auth bug");
    expect(injected.body).toContain("auth");
    expect(injected.memories.length).toBeGreaterThan(0);

    // Step 7: outcome tracking - record success on the top memory
    const updated = recordOutcomeAndFeedback(db, {
      memoryId: top.id,
      sessionId,
      outcome: "success",
      context: "Used the warning to plan a fix",
    });
    expect(updated.memory).not.toBeNull();
    expect(updated.memory!.successCount).toBe(1);
    expect(updated.memory!.confidence).toBeCloseTo(2 / 3, 5);

    // Step 8: verify feedback was persisted
    const feedbackRows = db.prepare("SELECT * FROM memory_feedback WHERE memory_id = ?").all(top.id) as any[];
    expect(feedbackRows).toHaveLength(1);
    expect(feedbackRows[0].outcome).toBe("success");
    expect(feedbackRows[0].session_id).toBe(sessionId);

    // Step 9: re-search and confirm top memory still wins after confidence boost
    const search2 = await retrieval.search("auth token rotation");
    expect(search2.memories[0].id).toBe(top.id);
    expect(search2.memories[0].successCount).toBe(1);

    // Step 10: end the session
    capture.endSession(sessionId, "completed");
    const finalSession = new SessionStore(db).getSessionByContentId(sessionId);
    expect(finalSession?.status).toBe("completed");

    closeDatabase({ db, dbPath });
  });

  it("normalizes OpenCode message.part.updated (text) events", () => {
    const adapter = new OpenCodeAdapter();
    const input = {
      platform: "opencode",
      event: "message.part.updated",
      sessionId: "s1",
      cwd: "/tmp",
      part: { type: "text", role: "user", text: "fix the login bug" },
    };
    const out = adapter.normalizeInput(input);
    expect(out.hookEvent).toBe("user_prompt");
    expect(out.prompt).toBe("fix the login bug");
  });

  it("normalizes OpenCode message.part.updated (tool) events", () => {
    const adapter = new OpenCodeAdapter();
    const input = {
      platform: "opencode",
      event: "message.part.updated",
      sessionId: "s1",
      cwd: "/tmp",
      part: { type: "tool", tool: "bash", input: { command: "ls -la" } },
    };
    const out = adapter.normalizeInput(input);
    expect(out.hookEvent).toBe("tool_use");
    expect(out.toolName).toBe("bash");
    expect(out.command).toBe("ls -la");
  });

  it("normalizes OpenCode command.executed events", () => {
    const adapter = new OpenCodeAdapter();
    const input = {
      platform: "opencode",
      event: "command.executed",
      sessionId: "s1",
      cwd: "/tmp",
      command: "npm test",
      exitCode: 0,
    };
    const out = adapter.normalizeInput(input);
    expect(out.hookEvent).toBe("command");
    expect(out.command).toBe("npm test");
    expect(out.commandExitCode).toBe(0);
  });

  it("normalizes session lifecycle events", () => {
    const adapter = new OpenCodeAdapter();
    const start = adapter.normalizeInput({
      platform: "opencode", event: "session.created", sessionId: "s1", cwd: "/tmp",
    });
    expect(start.hookEvent).toBe("session_start");
    expect(start.sessionSource).toBe("startup");

    const end = adapter.normalizeInput({
      platform: "opencode", event: "session.idle", sessionId: "s1", cwd: "/tmp",
    });
    expect(end.hookEvent).toBe("session_end");
  });
});

function buildTraceFromObservations(rows: any[]): string {
  return rows
    .map((r) => {
      const obs = JSON.parse(r.text);
      return `[${r.type}] ${obs.title ?? ""}: ${obs.narrative ?? ""}`;
    })
    .join("\n");
}
