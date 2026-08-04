export function tokenBudgetToChars(tokens: number): number {
  return Math.max(1, Math.floor(tokens) * 4);
}

export function fitText(value: string, tokenLimit: number): string {
  const limit = tokenBudgetToChars(tokenLimit);
  if (value.length <= limit) return value;
  const marker = "\n\n[Termyte context truncated to configured limit]";
  return `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

export function compactAll(records: string[], tokenLimit: number): string[] {
  if (records.length === 0) return [];
  const total = tokenBudgetToChars(tokenLimit);
  const separators = Math.max(0, records.length - 1) * 2;
  const perRecord = Math.max(48, Math.floor((total - separators) / records.length));
  return records.map((record) => record.length <= perRecord ? record : `${record.slice(0, Math.max(0, perRecord - 3))}...`);
}
