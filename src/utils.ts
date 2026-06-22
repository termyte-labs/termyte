import crypto from "node:crypto";

export function generateId(): string {
  return crypto.randomUUID();
}

export function fingerprint(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

export function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24);
}

export function redactSecrets(text: string): string {
  const patterns = [
    /(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi,
    /(?:sk|pk|ak|rk)_[a-zA-Z0-9]{20,}/g,
    /ghp_[a-zA-Z0-9]{36,}/g,
    /xox[bpas]-[a-zA-Z0-9-]+/g,
  ];
  let redacted = text;
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (match) => {
      const eqIndex = match.search(/[:=]/);
      if (eqIndex >= 0) {
        return match.slice(0, eqIndex + 1) + " [REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
