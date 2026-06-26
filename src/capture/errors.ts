/**
 * Adapter-level errors. `AdapterRejectedInput` is the only way an adapter
 * signals that a payload cannot be turned into a NormalizedHookInput — the
 * runner maps it to a non-error no-op so a malformed hook from one agent
 * never crashes the others.
 */

export class AdapterRejectedInput extends Error {
  constructor(public readonly reason: string) {
    super(`adapter rejected input: ${reason}`);
    this.name = "AdapterRejectedInput";
  }
}

/** Cwd must be a non-empty string. Adapters that fall back to process.cwd()
 *  still must pass through this check. */
export function isValidCwd(cwd: unknown): cwd is string {
  return typeof cwd === "string" && cwd.length > 0;
}
