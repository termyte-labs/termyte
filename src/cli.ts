#!/usr/bin/env node
import path from "node:path";
import { defaultDbPath, openDatabase } from "./db.js";
import { CaptureEngine } from "./capture/index.js";
import { createMemoryEngine } from "./memory/index.js";
import { recordOutcomeAndFeedback } from "./memory/outcome.js";
import { createGeminiClient, type GeminiClient } from "./extraction/gemini.js";
import { createRetrievalEngine } from "./retrieval/index.js";
import { formatForAgent } from "./retrieval/inject.js";
import { recordFeedback, getFeedbackStats } from "./feedback/index.js";
import { applyDecay } from "./memory/decay.js";
import { SessionStore } from "./hook-system/session-store.js";
import { SessionSearch } from "./hook-system/session-search.js";
import { ResponseProcessor } from "./extraction/response-processor.js";
import { PendingProcessor } from "./extraction/pending-processor.js";
import { getAdapter, detectPlatform } from "./hook-system/adapters.js";
import { readStdin, buildHookResult } from "./hook-system/hook-io.js";
import { generateId, nowISO } from "./utils.js";
import fs from "node:fs";
import os from "node:os";

function printUsage(): void {
  console.log(`Termyte - Self-correcting memory for coding agents

Usage:
  termyte init                                  Initialize .termyte/ directory
  termyte capture start [--session <id>]        Start a session capture
  termyte capture end --session <id>            End session and extract memories
  termyte search "<query>" [--scope <scope>]    Search memories
  termyte inject --task "<task>" [--scope <s>]  Generate context for agent
  termyte memories list [--type <type>]         List stored memories
  termyte memories show <id>                    Show memory details
  termyte feedback --memory <id> --outcome <success|failure|ignored>
  termyte decay [--dry-run]                     Apply memory decay
  termyte index [--reindex]                     Index memories for vector search
  termyte sessions list                         List captured sessions
  termyte sessions show <id>                    Show session details
  termyte process [--batch <n>]                 Process pending hook messages through Gemini
  termyte hook [--no-process]                   Process hook event from stdin
  termyte plugin install [--global]             Install OpenCode plugin
  termyte consolidate [--scope <s>] [--dry-run] Run the memory consolidation agent
  termyte stats                                 Show memory statistics`);
}

function requireArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "-h" || command === "--help") {
    printUsage();
    return 0;
  }

  const cwd = process.cwd();
  const dbPath = defaultDbPath(cwd);
  const { db } = openDatabase(dbPath);
  const project = path.basename(cwd);

  try {
    if (command === "init") {
      console.log(`Initialized Termyte at ${path.dirname(dbPath)}`);
      console.log(`Database: ${dbPath}`);
      return 0;
    }

    if (command === "capture") {
      const subcommand = args[1];
      const capture = new CaptureEngine(db);

      if (subcommand === "start") {
        const contentSessionId = requireArg(args, "--session");
        const session = capture.startSession(project, "termyte", undefined, contentSessionId);
        console.log(JSON.stringify({
          contentSessionId: session.contentSessionId,
          memorySessionId: session.memorySessionId,
          project: session.project,
          startedAt: session.startedAt,
        }));
        return 0;
      }

      if (subcommand === "end") {
        const contentSessionId = requireArg(args, "--session");
        if (!contentSessionId) {
          console.error("Missing --session <id>");
          return 1;
        }

        capture.endSession(contentSessionId, "completed");
        console.log(JSON.stringify({ contentSessionId, status: "completed" }));
        return 0;
      }

      console.error("Usage: termyte capture start|end");
      return 1;
    }

    if (command === "search") {
      const query = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      const scope = requireArg(args, "--scope");
      if (!query) {
        console.error('Usage: termyte search "<query>" [--scope <scope>]');
        return 1;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error("Missing GEMINI_API_KEY environment variable");
        return 1;
      }

      const gemini = createGeminiClient(apiKey);
      const retrieval = createRetrievalEngine(db, gemini);
      const result = await retrieval.search(query, { scope: scope ?? undefined });

      console.log(JSON.stringify({
        query,
        count: result.totalCount,
        queryTime: result.queryTime,
        memories: result.memories.map((m) => ({
          id: m.id,
          claim: m.claim,
          type: m.type,
          confidence: m.confidence,
          score: m.score,
          matchedBecause: m.matchedBecause,
        })),
      }, null, 2));
      return 0;
    }

    if (command === "inject") {
      const task = requireArg(args, "--task");
      const scope = requireArg(args, "--scope");
      if (!task) {
        console.error('Usage: termyte inject --task "<task>" [--scope <scope>]');
        return 1;
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error("Missing GEMINI_API_KEY environment variable");
        return 1;
      }

      const gemini = createGeminiClient(apiKey);
      const retrieval = createRetrievalEngine(db, gemini);
      const injected = await retrieval.inject(task, { scope: scope ?? undefined });
      console.log(formatForAgent(injected));
      return 0;
    }

    if (command === "memories") {
      const subcommand = args[1];
      const memoryEngine = createMemoryEngine(db);

      if (subcommand === "list") {
        const type = requireArg(args, "--type") as never;
        const scope = requireArg(args, "--scope");
        const memories = memoryEngine.listMemories({
          type: type ?? undefined,
          scope: scope ?? undefined,
          limit: 50,
        });
        console.log(JSON.stringify(memories.map((m) => ({
          id: m.id,
          claim: m.claim,
          type: m.type,
          confidence: m.confidence,
          successCount: m.successCount,
          failureCount: m.failureCount,
          repoScope: m.repoScope,
          language: m.language,
          updatedAt: m.updatedAt,
        })), null, 2));
        return 0;
      }

      if (subcommand === "show") {
        const id = args[2];
        if (!id) {
          console.error("Usage: termyte memories show <id>");
          return 1;
        }
        const memory = memoryEngine.getMemory(id);
        if (!memory) {
          console.error(`Memory not found: ${id}`);
          return 1;
        }
        const stats = getFeedbackStats(db, id);
        console.log(JSON.stringify({ ...memory, feedbackStats: stats }, null, 2));
        return 0;
      }

      console.error("Usage: termyte memories list|show");
      return 1;
    }

    if (command === "feedback") {
      const memoryId = requireArg(args, "--memory");
      const outcome = requireArg(args, "--outcome") as "success" | "failure" | "ignored";
      const context = requireArg(args, "--context");
      if (!memoryId || !outcome) {
        console.error("Usage: termyte feedback --memory <id> --outcome <success|failure|ignored>");
        return 1;
      }

      if (outcome === "ignored") {
        recordFeedback(db, memoryId, outcome, { context });
        console.log(JSON.stringify({ memoryId, outcome, recorded: true }));
        return 0;
      }

      const result = recordOutcomeAndFeedback(db, {
        memoryId,
        sessionId: "cli",
        outcome,
        context,
      });
      console.log(JSON.stringify({
        memoryId,
        outcome,
        recorded: true,
        newConfidence: result.memory?.confidence,
      }));
      return 0;
    }

    if (command === "decay") {
      const dryRun = hasFlag(args, "--dry-run");
      const results = applyDecay(db, { dryRun });
      console.log(JSON.stringify({ dryRun, affected: results.length, results }, null, 2));
      return 0;
    }

    if (command === "consolidate") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error("Missing GEMINI_API_KEY environment variable");
        return 1;
      }
      const { runConsolidation } = await import("./consolidation/index.js");
      const scope = requireArg(args, "--scope");
      const dryRun = hasFlag(args, "--dry-run");
      const result = await runConsolidation(db, apiKey, { scope: scope ?? undefined, dryRun });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    if (command === "process") {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error("Missing GEMINI_API_KEY environment variable");
        return 1;
      }

      const gemini = createGeminiClient(apiKey);
      const processor = new PendingProcessor(db, gemini, cwd);
      const batchSizeOpt = requireArg(args, "--batch");
      const result = await processor.processPending({ batchSize: batchSizeOpt ? parseInt(batchSizeOpt) : 10 });
      console.log(JSON.stringify(result));
      return 0;
    }

    if (command === "index") {
      const reindex = hasFlag(args, "--reindex");
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.error("Missing GEMINI_API_KEY environment variable");
        return 1;
      }

      const gemini = createGeminiClient(apiKey);
      const retrieval = createRetrievalEngine(db, gemini);

      if (reindex) {
        await retrieval.reindexAll();
        console.log("Reindexed all memories");
      } else {
        console.log("Index ready. Use --reindex to rebuild all embeddings.");
      }
      return 0;
    }

    if (command === "sessions") {
      const subcommand = args[1];
      const sessionStore = new SessionStore(db);
      const sessionSearch = new SessionSearch(db);

      if (subcommand === "list") {
        const sessions = sessionStore.listSessions({ limit: 20 });
        console.log(JSON.stringify(sessions.map((s) => ({
          contentSessionId: s.contentSessionId,
          memorySessionId: s.memorySessionId,
          project: s.project,
          platformSource: s.platformSource,
          status: s.status,
          promptCounter: s.promptCounter,
          startedAt: s.startedAt,
          completedAt: s.completedAt,
        })), null, 2));
        return 0;
      }

      if (subcommand === "show") {
        const contentSessionId = args[2];
        if (!contentSessionId) {
          console.error("Usage: termyte sessions show <content_session_id>");
          return 1;
        }
        const session = sessionStore.getSessionByContentId(contentSessionId);
        if (!session) {
          console.error(`Session not found: ${contentSessionId}`);
          return 1;
        }
        const observations = sessionSearch.getObservationsForSession(session.memorySessionId!);
        console.log(JSON.stringify({ session, observationCount: observations.length }, null, 2));
        return 0;
      }

      console.error("Usage: termyte sessions list|show");
      return 1;
    }

    if (command === "plugin") {
      const subcommand = args[1];
      if (subcommand !== "install") {
        console.error("Usage: termyte plugin install [--global] [--target <opencode|claude-code>]");
        return 1;
      }

      const target = (requireArg(args, "--target") ?? "opencode") as string;
      const isGlobal = hasFlag(args, "--global") || hasFlag(args, "-g");
      const installDir = isGlobal
        ? path.join(os.homedir(), ".config", "opencode", "plugins")
        : path.join(cwd, ".opencode", "plugins");
      fs.mkdirSync(installDir, { recursive: true });

      if (target === "opencode") {
        const templatePath = path.join(
          path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
          "hook-system",
          "opencode-plugin.template.js",
        );
        let template: string;
        try {
          template = fs.readFileSync(templatePath, "utf-8");
        } catch {
          const distRoot = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"));
          const candidates = [
            path.join(distRoot, "hook-system", "opencode-plugin.template.js"),
            path.join(distRoot, "..", "src", "hook-system", "opencode-plugin.template.ts"),
            path.join(process.cwd(), "src", "hook-system", "opencode-plugin.template.ts"),
          ];
          let found: string | null = null;
          for (const c of candidates) {
            if (fs.existsSync(c)) { found = c; break; }
          }
          if (!found) {
            console.error("Could not locate opencode-plugin.template");
            return 1;
          }
          template = fs.readFileSync(found, "utf-8");
        }
        const dest = path.join(installDir, "termyte.ts");
        fs.writeFileSync(dest, template);
        console.log(JSON.stringify({
          installed: true,
          target: "opencode",
          location: isGlobal ? "global" : "project",
          path: dest,
        }));
        return 0;
      }

      console.error(`Unknown plugin target: ${target}`);
      return 1;
    }

    if (command === "hook") {
      const rawInput = await readStdin();
      if (!rawInput || typeof rawInput !== "object") {
        console.log(JSON.stringify(buildHookResult({ hookEventName: "termyte", additionalContext: "" })));
        return 0;
      }

      const detectedPlatform = detectPlatform(rawInput);
      const adapter = getAdapter(detectedPlatform);
      const normalized = adapter.normalizeInput(rawInput);
      const sessionStore = new SessionStore(db);
      const responseProcessor = new ResponseProcessor({ db, workspaceRoot: cwd });

      const event = normalized.hookEvent;
      const isSessionStart = event === "session_start"
        || normalized.sessionSource === "startup"
        || normalized.sessionSource === "resume";
      const isSessionEnd = event === "session_end"
        || normalized.sessionSource === "clear"
        || (normalized.prompt === undefined
          && normalized.toolName === undefined
          && normalized.lastAssistantMessage === undefined
          && normalized.filePath === undefined
          && normalized.command === undefined
          && normalized.sessionSource !== "startup");

      if (isSessionStart) {
        let session = sessionStore.getSessionByContentId(normalized.sessionId);
        if (!session) {
          session = sessionStore.createSession({
            contentSessionId: normalized.sessionId,
            project,
            platformSource: detectedPlatform,
            userPrompt: normalized.prompt,
          });
        }
        console.log(JSON.stringify(buildHookResult({ hookEventName: "session_start", additionalContext: "" })));
        return 0;
      }

      const session = sessionStore.getSessionByContentId(normalized.sessionId);
      if (!session) {
        console.log(JSON.stringify(buildHookResult({ hookEventName: "termyte", additionalContext: "Session not found" })));
        return 0;
      }

      if (event === "user_prompt" || (event === undefined && normalized.prompt)) {
        await responseProcessor.processUserPrompt(normalized);
      }

      const isToolEvent = event === "tool_use"
        || event === "command"
        || event === "file_edit"
        || (event === undefined && (normalized.toolName !== undefined || normalized.command !== undefined || normalized.filePath !== undefined));
      if (isToolEvent && (normalized.toolName !== undefined || normalized.command !== undefined || normalized.filePath !== undefined)) {
        await responseProcessor.processToolUse(normalized);
      }

      if (isSessionEnd) {
        await responseProcessor.processSessionEnd(normalized.sessionId);
      }

      if (hasFlag(args, "--no-process") === false && process.env.TERMYTE_AUTO_PROCESS !== "0") {
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey && isToolEvent) {
          try {
            const { createGeminiClient } = await import("./extraction/gemini.js");
            const { PendingProcessor } = await import("./extraction/pending-processor.js");
            const gemini = createGeminiClient(apiKey);
            const processor = new PendingProcessor(db, gemini, cwd);
            await Promise.race([
              processor.processPending({ batchSize: 3 }),
              new Promise<void>((resolve) => setTimeout(resolve, 4000)),
            ]);
          } catch (err) {
            console.error("[termyte] inline flush failed:", err instanceof Error ? err.message : String(err));
          }
        }
      }

      console.log(JSON.stringify(buildHookResult({ hookEventName: event ?? "termyte", additionalContext: "" })));
      return 0;
    }

    if (command === "stats") {
      const memoryEngine = createMemoryEngine(db);
      const total = memoryEngine.countMemories();
      const facts = memoryEngine.countMemories({ type: "fact" });
      const bugfixes = memoryEngine.countMemories({ type: "bugfix" });
      const procedures = memoryEngine.countMemories({ type: "procedure" });
      const conventions = memoryEngine.countMemories({ type: "convention" });
      const warnings = memoryEngine.countMemories({ type: "warning" });

      const sessionCount = db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number };
      const observationCount = db.prepare("SELECT COUNT(*) as cnt FROM observations").get() as { cnt: number };

      console.log(JSON.stringify({
        total,
        byType: { facts, bugfixes, procedures, conventions, warnings },
        sessions: sessionCount.cnt,
        observations: observationCount.cnt,
        databasePath: dbPath,
      }, null, 2));
      return 0;
    }

    printUsage();
    return 1;
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
