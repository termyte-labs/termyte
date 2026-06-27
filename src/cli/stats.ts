/**
 * `termyte stats` — report unprocessed-trace counts, the configured
 * agent adapter (if any), the local model, and today's synthesis
 * spend. Local-only, never phones home.
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { discoverAdapter } from "../synth/index.js";
import { Spend } from "../synth/spend.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const unprocessed = store.getUnprocessedTraces(10_000).length;
    const recent = store.getRecentSessions(10);
    // H4: respect TERMYTE_SYNTH_ADAPTER override so users can pin a
    // specific synthesis adapter and not be billed against a different
    // agent's plan.
    const adapter = process.env.TERMYTE_SYNTH_ADAPTER
      ? (process.env.TERMYTE_SYNTH_ADAPTER as string)
      : await discoverAdapter();
    const lines = [
      `db:                  ${config.dbPath}`,
      `embedding model:     ${config.embeddings.model} (local ONNX)`,
      `synthesis adapter:   ${adapter ?? "(none found — install Claude Code / Codex / OpenCode / Gemini CLI)"}`,
      `unprocessed traces:  ${unprocessed}${unprocessed >= 10_000 ? "+ (capped)" : ""}`,
      `recent sessions:     ${recent.length}`,
    ];
    // Append today's spend. C20: cost telemetry in stats.
    const today = Spend.today();
    if (today) {
      const todayKey = new Date().toISOString().slice(0, 10);
      lines.push("");
      lines.push(`today (${todayKey}):`);
      lines.push(`  invocations:    ${today.invocations}`);
      lines.push(`  input tokens:   ${today.input_tokens.toLocaleString()}`);
      lines.push(`  output tokens:  ${today.output_tokens.toLocaleString()}`);
      lines.push(`  est. cost USD:   $${today.est_cost_usd.toFixed(4)}`);
      const maxInv = parseInt(process.env.TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS ?? "50", 10);
      const maxCost = parseFloat(process.env.TERMYTE_SYNTH_DAILY_BUDGET_USD ?? "0.50");
      const pct = Math.min(100, Math.round((today.invocations / maxInv) * 100));
      lines.push(`  daily budget:    $${maxCost.toFixed(2)} / ${maxInv} invocations (${pct}% used)`);
    } else {
      lines.push("");
      lines.push("today: (no spend data — synthesize something first)");
    }
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    store.close();
  }
}

main().catch((err) => {
  process.stderr.write(`termyte: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// Re-exported entry point so `termyte stats` can delegate here.
export async function runMain(): Promise<void> {
  await main();
}
