/**
 * Central memory lifecycle eligibility policy for default retrieval.
 *
 * Default retrieval (FTS, vector, recent-memory context, MCP, CLI) returns
 * only "eligible" memories. Stale, conflicted, superseded, deleted, and
 * failed memories are excluded unless a caller explicitly requests all
 * states (e.g. a diagnostic override).
 *
 * The single source of truth is `lifecycle_state`. By default only `active`
 * memories are eligible.
 */

/** Lifecycle states returned by default retrieval. */
export const DEFAULT_ELIGIBLE_MEMORY_STATES: readonly string[] = ["active"];

/** Every known memory lifecycle state — used by explicit diagnostic overrides. */
export const ALL_MEMORY_STATES: readonly string[] = [
  "active",
  "stale",
  "superseded",
  "conflicted",
  "deleted",
  "failed",
  "awaiting_embedding",
  "consolidating",
];

/** The states a caller wants; defaults to the policy above. */
export function eligibleMemoryStates(override?: readonly string[]): readonly string[] {
  return override ?? DEFAULT_ELIGIBLE_MEMORY_STATES;
}

/** True when a memory should be returned by default retrieval. */
export function isMemoryEligible(
  memory: { lifecycle_state?: string | null },
  states: readonly string[] = DEFAULT_ELIGIBLE_MEMORY_STATES,
): boolean {
  const state = memory.lifecycle_state ?? "active";
  return states.includes(state);
}

/** Build a SQL predicate `alias.lifecycle_state IN (...)` plus bind params. */
export function memoryEligibilitySql(
  alias: string,
  states: readonly string[] = DEFAULT_ELIGIBLE_MEMORY_STATES,
): { clause: string; params: string[] } {
  const list = states.length > 0 ? states : DEFAULT_ELIGIBLE_MEMORY_STATES;
  const placeholders = list.map(() => "?").join(", ");
  return { clause: `${alias}.lifecycle_state IN (${placeholders})`, params: [...list] };
}
