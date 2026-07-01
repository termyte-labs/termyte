export interface RankedResultLike {
  id: string;
}

export function recallAtK(results: RankedResultLike[], expectedIds: string[], k: number): number {
  const expected = unique(expectedIds);
  if (expected.length === 0) return 1;

  const top = new Set(results.slice(0, k).map((result) => result.id));
  const hits = expected.filter((id) => top.has(id)).length;
  return hits / expected.length;
}

export function precisionAtK(results: RankedResultLike[], expectedIds: string[], k: number): number {
  if (k <= 0) return 0;

  const top = results.slice(0, k);
  if (top.length === 0) return expectedIds.length === 0 ? 1 : 0;

  const expected = new Set(expectedIds);
  const hits = top.filter((result) => expected.has(result.id)).length;
  const denominator = Math.max(1, Math.min(k, expected.size));
  return hits / denominator;
}

export function mrr(results: RankedResultLike[], expectedIds: string[]): number {
  const expected = new Set(expectedIds);
  if (expected.size === 0) return 1;

  const index = results.findIndex((result) => expected.has(result.id));
  return index === -1 ? 0 : 1 / (index + 1);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
