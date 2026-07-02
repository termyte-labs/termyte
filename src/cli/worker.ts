/**
 * `termyte-worker` - standalone observer process.
 *
 * Polls the `traces` table for unprocessed rows, runs the observer on
 * them, and exits when the queue is empty. Designed to be run by a
 * cron, a systemd timer, or a long-lived supervisor; it does not
 * daemonize itself.
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { OpenAICompatibleProvider } from "../observer/openai-provider.js";
import { LocalEmbeddingsProvider } from "../retrieval/local-embeddings.js";
import { MemoryPipeline } from "../pipeline/memory-pipeline.js";
import { acquireWorkerLock, releaseWorkerLock } from "../pipeline/worker-supervisor.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(config.dbPath);

  // Single-instance: a supervised worker is spawned per hook event; only one
  // may drain a given database. Redundant spawns exit here without work.
  if (!acquireWorkerLock(config.dbPath, process.pid)) {
    process.stdout.write("termyte-worker: another worker is already draining this database; exiting.\n");
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ enqueued: 0, jobsProcessed: 0, lock: "busy" })}\n`);
    }
    store.close();
    return;
  }

  const llm = new OpenAICompatibleProvider(config.llm);
  const embeddings = new LocalEmbeddingsProvider({ model: config.embeddings.model });
  const pipeline = new MemoryPipeline({ store, llm, embeddings });

  try {
    const enqueued = pipeline.enqueueUnprocessedTraces(args.batchSize);
    const maxJobs = args.once ? 1 : args.maxJobs;
    const jobsProcessed = args.untilIdle || args.once
      ? await pipeline.runUntilIdle(args.workerId, { maxJobs })
      : await pipeline.runUntilIdle(args.workerId, { maxJobs });
    const stats = pipeline.getQueueStats();

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ enqueued, jobsProcessed, queue: stats })}\n`);
    } else {
      process.stdout.write(
        `termyte-worker: enqueued ${enqueued} trace(s), processed ${jobsProcessed} job(s)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`termyte-worker: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    releaseWorkerLock(config.dbPath);
    store.close();
  }
}

interface WorkerArgs {
  once: boolean;
  untilIdle: boolean;
  json: boolean;
  supervised: boolean;
  maxJobs: number;
  batchSize: number;
  workerId: string;
}

function parseArgs(argv: string[]): WorkerArgs {
  return {
    once: argv.includes("--once"),
    untilIdle: argv.includes("--until-idle"),
    json: argv.includes("--json"),
    supervised: argv.includes("--supervised"),
    maxJobs: readNumberArg(argv, "--max-jobs", 100),
    batchSize: readNumberArg(argv, "--batch-size", 50),
    workerId: readStringArg(argv, "--worker-id", `worker-${process.pid}`),
  };
}

function readStringArg(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function readNumberArg(argv: string[], name: string, fallback: number): number {
  const value = readStringArg(argv, name, String(fallback));
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

main();
