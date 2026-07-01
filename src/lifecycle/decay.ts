import type { MemoryState, MemoryType } from "../core/types.js";

export interface MemoryLifecycleRow {
  id: number;
  type: MemoryType | string;
  state: MemoryState;
  importance: number;
  confidence: number;
  usage_count: number;
  created_at: number;
  updated_at?: number | null;
  last_accessed_at?: number | null;
}

const DAY_MS = 86_400_000;

const HALF_LIFE_DAYS: Record<string, number> = {
  preference: 180,
  project_convention: 120,
  convention: 120,
  decision: 90,
  fact: 45,
  task_state: 14,
  warning: 60,
  bugfix: 45,
  procedure: 60,
  default: 45,
};

export function memoryDecayScore(memory: MemoryLifecycleRow, nowMs: number): number {
  const referenceTs = memory.updated_at ?? memory.created_at;
  const ageDays = Math.max(0, (nowMs - referenceTs) / DAY_MS);
  const accessReferenceTs = memory.last_accessed_at ?? referenceTs;
  const accessAgeDays = Math.max(0, (nowMs - accessReferenceTs) / DAY_MS);
  const halfLifeDays = HALF_LIFE_DAYS[memory.type] ?? HALF_LIFE_DAYS.default;

  const freshness = 0.5 ** (ageDays / halfLifeDays);
  const accessFreshness = 0.5 ** (accessAgeDays / 45);
  const boundedUsageBoost = Math.min(1, Math.log1p(memory.usage_count) / Math.log(20));

  return clamp01(
    0.34 * freshness +
      0.18 * accessFreshness +
      0.20 * memory.importance +
      0.18 * memory.confidence +
      0.10 * boundedUsageBoost,
  );
}

export function nextMemoryStateAfterDecay(
  memory: MemoryLifecycleRow,
  decayedScore: number,
): MemoryState {
  if (memory.state === "deleted" || memory.state === "superseded") return memory.state;
  return decayedScore < 0.22 ? "stale" : "active";
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

