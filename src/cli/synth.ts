/**
 * `termyte-synth` — one-shot background synthesis. Reads unprocessed
 * traces from the SQLite DB, hands them to the configured
 * AgentAdapter in batches, writes the resulting observations back to
 * the DB. Holds a process-wide lock so two invocations can't collide.
 *
 * Usage:
 *   termyte-synth                        # pick the first available adapter
 *   termyte-synth --adapter claude-code  # force a specific adapter
 *   termyte-synth --once                 # alias for the default mode
 *   termyte-synth --dry-run              # print the prompt, don't call the model
 *   termyte-synth --max-budget-usd 0.50  # cap spend
 *   termyte-synth --batch-size 25        # smaller batches
 *   termyte-synth --session <id>         # only synthesize one session
 *
 * Exit codes:
 *   0 = success (with or without observations)
 *   1 = synthesis failed after at least one batch
 *   2 = another instance holds the lock
 *   3 = no adapter available
 *   4 = user error (bad args)
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { Batcher } from "../synth/batcher.js";
import { Lock, LockBusyError } from "../synth/lock.js";
import { createAdapter, discoverAdapter, type AgentAdapterId } from "../synth/index.js";
import { buildBatchPrompt } from "../synth/prompts.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { createEmbeddingsProvider } from "../runtime/providers.js";

function printUsage(): void {
  process.stdout.write(`termyte-synth — generate observations from captured traces

Usage:
  termyte-synth [options]

Options:
  --adapter <id>       Force a specific adapter: claude-code | codex | opencode | gemini-cli
  --once               Run one pass and exit (default behavior)
  --dry-run            Print the prompt that would be sent, do not invoke the model
  --max-budget-usd N   Per-invocation spend cap (Claude Code only)
  --batch-size N       Traces per batch (default 50)
  --max-batches N      Max batches per run (default 5)
  --timeout-ms N       Per-batch wall-clock cap (default 300000)
  --session <id>       Only synthesize one session
  --repo <repo_id>     Only synthesize traces from a single repo
  --json               Emit the run summary as JSON
  --help               Print this message
`);
}

interface ParsedArgs {
  adapter?: AgentAdapterId;
  dryRun: boolean;
  maxBudgetUsd?: number;
  batchSize: number;
  maxBatches: number;
  timeoutMs: number;
  sessionId?: string;
  repoId?: string;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    dryRun: false, batchSize: 50, maxBatches: 5, timeoutMs: 5 * 60_000, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--adapter": out.adapter = argv[++i] as AgentAdapterId; break;
      case "--once": break;
      case "--dry-run": out.dryRun = true; break;
      case "--max-budget-usd": out.maxBudgetUsd = parseFloat(argv[++i]!); break;
      case "--batch-size": out.batchSize = parseInt(argv[++i]!, 10); break;
      case "--max-batches": out.maxBatches = parseInt(argv[++i]!, 10); break;
      case "--timeout-ms": out.timeoutMs = parseInt(argv[++i]!, 10); break;
      case "--session": out.sessionId = argv[++i]; break;
      case "--repo": out.repoId = argv[++i]; break;
      case "--json": out.json = true; break;
      case "--help": case "-h": out.help = true; break;
      default:
        process.stderr.write(`termyte-synth: unknown option: ${a}\n`);
        process.exit(4);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); return; }

  const config = loadConfig();
  const store = new Store(config.dbPath);
  const embeddings = createEmbeddingsProvider(config.embeddings.model);
  // Embeddings are warmed but not used by synthesis directly. We keep
  // a reference so the future observation-embedding pipeline can use
  // the same selection path without booting a different model.
  void embeddings;

  const lockPath = join(homedir(), ".termyte", "synth.lock");
  let lock: Lock | null = null;
  try {
    lock = Lock.acquire(lockPath, {
      pid: process.pid,
      startedAt: Date.now(),
      host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "unknown",
    });
  } catch (err) {
    if (err instanceof LockBusyError) {
      process.stderr.write(`termyte-synth: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  try {
    let adapterId = args.adapter;
    if (!adapterId) {
      adapterId = (await discoverAdapter()) ?? undefined;
    }
    if (!adapterId) {
      process.stderr.write("termyte-synth: no supported agent found in PATH.\n");
      process.stderr.write("  Install Claude Code (claude), Codex (codex), OpenCode (opencode), or Gemini CLI (gemini).\n");
      process.exit(3);
    }

    const adapter = createAdapter(adapterId);
    const available = await adapter.isAvailable();
    if (!available) {
      process.stderr.write(`termyte-synth: adapter '${adapterId}' reports not available.\n`);
      process.exit(3);
    }

    if (args.dryRun) {
      const batch = store.getUnprocessedTraces(args.batchSize);
      if (batch.length === 0) {
        process.stdout.write("(no unprocessed traces — nothing to synthesize)\n");
        return;
      }
      const prompt = buildBatchPrompt(batch.map((t) => ({
        id: t.id, tool_name: t.tool_name, tool_input: t.tool_input,
        tool_output: t.tool_output, user_prompt: t.user_prompt, timestamp: t.timestamp,
      })));
      process.stdout.write(`# would invoke ${adapterId} with the following prompt\n\n`);
      process.stdout.write(prompt);
      process.stdout.write(`\n\n# stats: ${batch.length} trace(s), ~${estimateTokens(prompt)} input tokens\n`);
      return;
    }

    const batcher = new Batcher(store, adapter);
    const result = await batcher.runOnce({
      batchSize: args.batchSize,
      maxBatches: args.maxBatches,
      perBatchTimeoutMs: args.timeoutMs,
      perBatchBudgetUsd: args.maxBudgetUsd,
      sessionId: args.sessionId,
      repoId: args.repoId,
    });
    const summary = {
      adapter: adapterId,
      ...result,
    };
    if (args.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } else {
      const lines = [
        `adapter:           ${adapterId}`,
        `batches:           ${result.batches}`,
        `traces read:       ${result.tracesRead}`,
        `observations:      ${result.observationsWritten}`,
        `duration:          ${result.durationMs}ms`,
      ];
      if (result.lastError) lines.push(`last error:        ${result.lastError.reason}: ${result.lastError.message}`);
      process.stdout.write(lines.join("\n") + "\n");
    }
    if (result.lastError) process.exit(1);
  } finally {
    lock?.release();
    store.close();
  }
}

function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token. Good enough for `--dry-run`.
  return Math.ceil(text.length / 4);
}

main().catch((err) => {
  process.stderr.write(`termyte-synth: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// Re-exported entry point so `termyte synth ...` can delegate here.
export async function runMain(): Promise<void> {
  await main();
}
