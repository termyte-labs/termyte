/**
 * Shared helpers for adapters. Kept tiny and dependency-free.
 */

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Return the first string-typed value found in `o` under the given keys. */
export function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const k of keys) {
    if (k in o) return null;
  }
  return null;
}
