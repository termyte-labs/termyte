export class RetryableJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableJobError";
  }
}

export class PermanentJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

export function isRetryableJobError(error: unknown): boolean {
  return !(error instanceof PermanentJobError);
}

export function serializeJobError(error: unknown): string {
  if (error instanceof Error) {
    return JSON.stringify({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  }

  try {
    return JSON.stringify({ name: "NonError", value: error });
  } catch {
    return JSON.stringify({ name: "NonError", value: String(error) });
  }
}

export function computeBackoffMs(attemptCount: number): number {
  const baseMs = 2_000;
  const maxMs = 10 * 60_000;
  const jitterMs = Math.floor(Math.random() * 1_000);
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attemptCount - 1)) + jitterMs;
}
