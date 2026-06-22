#!/usr/bin/env node
import path from "node:path";
import { defaultDbPath, openDatabase } from "./db.js";
import { CaptureEngine } from "./capture/index.js";
import { createMemoryEngine } from "./memory/index.js";
import { createGeminiClient, type GeminiClient } from "./extraction/gemini.js";
import { extractMemoriesFromTrace, buildTraceSummary } from "./extraction/index.js";
import { createRetrievalEngine } from "./retrieval/index.js";
import { buildInjectionContext, formatForAgent } from "./retrieval/inject.js";
import { recordFeedback, getFeedbackStats } from "./feedback/index.js";
import { applyDecay, deactivateLowConfidence } from "./memory/decay.js";
import { recordGitEvents } from "./capture/git.js";
import { generateId, nowISO } from "./utils.js";

function printUsage(): void {
  console.log(`Termyte - Self-correcting memory for coding agents

Usage:
  termyte init                                  Initialize .termyte/ directory
  termyte capture start --agent <name>          Start a session capture
  termyte capture end --session <id>            End session and extract memories
  termyte capture event --session <id> --type <type> --summary <text>
  termyte search "<query>" [--scope <scope>]    Search memories
  termyte inject --task "<task>" [--scope <s>]  Generate context for agent
  termyte memories list [--type <type>]         List stored memories
  termyte memories show <id>                    Show memory details
  termyte feedback --memory <id> --outcome <success|failure|ignored>
  termyte decay [--dry-run]                     Apply memory decay
  termyte index [--reindex]                     Index memories for vector search
  termyte sessions list                         List captured sessions
  termyte sessions show <id>                    Show session details
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
        const agent = requireArg(args, "--agent") ?? "unknown";
        const branch = requireArg(args, "--branch");
        const session = capture.startSession(agent, cwd, branch);
        console.log(JSON.stringify({ sessionId: session.id, agent: session.agent, startedAt: session.startedAt }));
        return 0;
      }

      if (subcommand === "end") {
        const sessionId = requireArg(args, "--session");
        if (!sessionId) {
          console.error("Missing --session <id>");
          return 1;
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          console.error("Missing GEMINI_API_KEY environment variable");
          return 1;
        }

        const gemini = createGeminiClient(apiKey);
        const events = capture.getEvents(sessionId);
        const session = capture.getSession(sessionId);

        if (events.length === 0) {
          capture.endSession(sessionId, "completed", "No events recorded");
          console.log(JSON.stringify({ sessionId, eventsExtracted: 0, memoriesExtracted: 0 }));
          return 0;
        }

        const trace = buildTraceSummary(events);
        const sourceIds = events.map((e) => e.id);
        const repoScope = path.basename(cwd);

        const extraction = await extractMemoriesFromTrace(gemini, trace, repoScope, sourceIds);

        const memoryEngine = createMemoryEngine(db);
        const retrieval = createRetrievalEngine(db, gemini);
        let createdCount = 0;

        for (const extracted of extraction.memories) {
          memoryEngine.createMemory({
            claim: extracted.claim,
            type: extracted.type,
            repoScope,
            language: extracted.language,
            sources: extracted.sources,
          });
          createdCount++;
        }

        capture.endSession(sessionId, "completed", `Extracted ${createdCount} memories`);

        console.log(JSON.stringify({
          sessionId,
          eventsExtracted: events.length,
          memoriesExtracted: createdCount,
          repoScope,
        }));
        return 0;
      }

      if (subcommand === "event") {
        const sessionId = requireArg(args, "--session");
        const eventType = requireArg(args, "--type") ?? "summary";
        const summary = requireArg(args, "--summary");
        if (!sessionId || !summary) {
          console.error("Usage: termyte capture event --session <id> --type <type> --summary <text>");
          return 1;
        }
        const event = capture.recordEvent({
          sessionId,
          source: "cli",
          actorType: "agent",
          eventType: eventType as never,
          summary,
        });
        console.log(JSON.stringify({ eventId: event.id }));
        return 0;
      }

      console.error("Usage: termyte capture start|end|event");
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

      const memoryEngine = createMemoryEngine(db);
      recordFeedback(db, memoryId, outcome, { context });

      if (outcome === "success") {
        memoryEngine.recordSuccess(memoryId);
      } else if (outcome === "failure") {
        memoryEngine.recordFailure(memoryId);
      }

      console.log(JSON.stringify({ memoryId, outcome, recorded: true }));
      return 0;
    }

    if (command === "decay") {
      const dryRun = hasFlag(args, "--dry-run");
      const results = applyDecay(db, { dryRun });
      console.log(JSON.stringify({ dryRun, affected: results.length, results }, null, 2));
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
      const capture = new CaptureEngine(db);

      if (subcommand === "list") {
        const sessions = capture.listSessions(20);
        console.log(JSON.stringify(sessions, null, 2));
        return 0;
      }

      if (subcommand === "show") {
        const id = args[2];
        if (!id) {
          console.error("Usage: termyte sessions show <id>");
          return 1;
        }
        const session = capture.getSession(id);
        if (!session) {
          console.error(`Session not found: ${id}`);
          return 1;
        }
        const events = capture.getEvents(id);
        console.log(JSON.stringify({ session, events }, null, 2));
        return 0;
      }

      console.error("Usage: termyte sessions list|show");
      return 1;
    }

    if (command === "stats") {
      const memoryEngine = createMemoryEngine(db);
      const total = memoryEngine.countMemories();
      const facts = memoryEngine.countMemories({ type: "fact" });
      const bugfixes = memoryEngine.countMemories({ type: "bugfix" });
      const procedures = memoryEngine.countMemories({ type: "procedure" });
      const conventions = memoryEngine.countMemories({ type: "convention" });
      const warnings = memoryEngine.countMemories({ type: "warning" });

      console.log(JSON.stringify({
        total,
        byType: { facts, bugfixes, procedures, conventions, warnings },
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
