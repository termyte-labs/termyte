/**
 * Circuit breaker for LLM provider calls.
 * Adapted from agentmemory's src/providers/circuit-breaker.ts.
 *
 * States: closed → open (after N failures in window) → half-open (after timeout) → closed.
 */

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private failureCount = 0;
  private lastFailureMs = 0;
  private state: CircuitState = "closed";
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly windowMs: number;

  constructor(opts?: { failureThreshold?: number; resetTimeoutMs?: number; windowMs?: number }) {
    this.failureThreshold = opts?.failureThreshold ?? 3;
    this.resetTimeoutMs = opts?.resetTimeoutMs ?? 30_000;
    this.windowMs = opts?.windowMs ?? 60_000;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureMs > this.resetTimeoutMs) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    const now = Date.now();
    if (now - this.lastFailureMs > this.windowMs) {
      this.failureCount = 0;
    }
    this.failureCount++;
    this.lastFailureMs = now;
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
    }
  }

  get currentState(): CircuitState {
    return this.state;
  }
}