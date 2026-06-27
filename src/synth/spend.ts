/**
 * Persistent spend tracker for background synthesis.
 *
 * Shared by the synth CLI (C3: BudgetGuard denies invocations when
 * the daily cap is hit) and `termyte stats` (C20: shows today's
 * invocations / tokens / estimated cost). The file uses atomic
 * temp-file rename for safe concurrent writes from a single
 * `termyte-synth` process. The lock file in `lock.ts` already
 * serializes invocations across processes, so the rename is
 * sufficient for our concurrency model.
 *
 * The file includes a SHA-256 checksum (E2) so partial reads on
 * FAT32/exFAT or after a power loss are detected and reported as
 * "data unavailable" rather than silently showing $0.
 *
 * Format:
 *   {
 *     "checksum": "<sha256-hex>",
 *     "days": {
 *       "2026-06-26": {
 *         "invocations": 8,
 *         "input_tokens": 4231,
 *         "output_tokens": 1108,
 *         "est_cost_usd": 0.012
 *       }
 *     }
 *   }
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir as osHomedir } from "node:os";

export interface DailySpend {
  invocations: number;
  input_tokens: number;
  output_tokens: number;
  /** Estimated cost in USD. Best-effort — depends on the agent CLI
   *  reporting token counts; we don't have a public model-price
   *  table, so this is the raw number the CLI gave us. */
  est_cost_usd: number;
}

export interface SpendFile {
  checksum: string;
  days: Record<string, DailySpend>;
}

export interface BudgetConfig {
  /** Max invocations per day. Default 50. */
  maxInvocationsPerDay?: number;
  /** Max estimated USD spend per day. Default 0.50. */
  maxCostPerDayUsd?: number;
}

/** Module-local path cache. `_resetPathForTest()` clears it. */
let _spendPath: string | null = null;

function currentSpendPath(): string {
  if (_spendPath === null) {
    const home = process.env.TERMYTE_HOME ?? osHomedir();
    _spendPath = join(home, ".termyte", "spend.json");
  }
  return _spendPath;
}

/** Test-only: clear the path cache so a HOME change is picked up. */
export function _resetPathForTest(): void { _spendPath = null; }

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDaily(): DailySpend {
  return { invocations: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 };
}

function checksumOf(file: Omit<SpendFile, "checksum">): string {
  // Sort keys for determinism.
  const sorted = JSON.stringify(file, Object.keys(file).sort());
  return createHash("sha256").update(sorted).digest("hex");
}

function readSpendFile(): SpendFile {
  const path = currentSpendPath();
  if (!existsSync(path)) {
    return { checksum: "", days: {} };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as SpendFile;
    const { checksum, ...rest } = parsed;
    if (typeof checksum !== "string") {
      return { checksum: "", days: {} };
    }
    if (checksumOf(rest as Omit<SpendFile, "checksum">) !== checksum) {
      return { checksum: "", days: {} };
    }
    return parsed;
  } catch {
    return { checksum: "", days: {} };
  }
}

function writeSpendFile(file: SpendFile): void {
  const path = currentSpendPath();
  mkdirSync(dirname(path), { recursive: true });
  // Compute checksum over the body (everything except `checksum`).
  // We strip the input `checksum` field defensively in case the
  // caller passed a full SpendFile (the read-modify-write path
  // passes the read result which has the old checksum).
  const body: Omit<SpendFile, "checksum"> = { days: file.days };
  const checksum = checksumOf(body);
  const withChecksum: SpendFile = { checksum, ...body };
  const tmpPath = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(withChecksum, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

export class Spend {
  /**
   * Record one synthesis invocation. Called by the synth CLI after
   * the model returns. If the daily cap is exceeded, the
   * invocation is *not* recorded and the function returns false.
   * The caller should skip the synthesis and tell the user.
   */
  static record(usage: { input?: number; output?: number; estCostUsd?: number }, config: BudgetConfig = {}): { allowed: boolean; spend: DailySpend; total: DailySpend } {
    const maxInv = config.maxInvocationsPerDay ?? 50;
    const maxCost = config.maxCostPerDayUsd ?? 0.50;
    const file = readSpendFile();
    const key = todayKey();
    const day = file.days[key] ?? emptyDaily();

    if (day.invocations >= maxInv) {
      return { allowed: false, spend: day, total: day };
    }

    // Compute the prospective total. Deny if this invocation
    // would push us over the cap — even if the *current* total is
    // still under it. This prevents "one more 0.30" from exceeding
    // a 0.50 cap.
    const nextInvocations = day.invocations + 1;
    const nextCost = day.est_cost_usd + (usage.estCostUsd ?? 0);
    if (nextInvocations > maxInv || nextCost > maxCost) {
      return { allowed: false, spend: day, total: day };
    }

    const updated: DailySpend = {
      invocations: nextInvocations,
      input_tokens: day.input_tokens + (usage.input ?? 0),
      output_tokens: day.output_tokens + (usage.output ?? 0),
      est_cost_usd: nextCost,
    };
    file.days[key] = updated;
    try { writeSpendFile(file); } catch { /* best-effort */ }
    return { allowed: true, spend: updated, total: updated };
  }

  /** Read today's spend. Returns null if the file is corrupt or absent. */
  static today(): DailySpend | null {
    const file = readSpendFile();
    if (file.checksum === "") return null;
    return file.days[todayKey()] ?? emptyDaily();
  }

  /** Read the full file (used by `termyte stats`). */
  static read(): SpendFile {
    return readSpendFile();
  }
}

/** Re-export the path so the stats CLI and tests can clear it. */
export const SPEND_FILE_PATH = "computed at runtime via currentSpendPath()";
