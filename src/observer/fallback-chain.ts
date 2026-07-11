/**
 * Fallback chain and resilient providers for LLM calls.
 * Adapted from agentmemory's src/providers/fallback-chain.ts and resilient.ts.
 */

import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from "./provider.js";
import { CircuitBreaker } from "./circuit-breaker.js";

/**
 * Wraps an LLM provider in a circuit breaker so repeated failures
 * short-circuit instead of propagating errors to the job queue.
 */
export class ResilientProvider implements LLMProvider {
  private breaker: CircuitBreaker;

  constructor(private inner: LLMProvider, breaker?: CircuitBreaker) {
    this.breaker = breaker ?? new CircuitBreaker();
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    return this.breaker.exec(async () => this.inner.chat(messages, options));
  }

  get circuitState() {
    return this.breaker.currentState;
  }
}

/**
 * Tries each provider in sequence; throws the last error if all fail.
 */
export class FallbackChainProvider implements LLMProvider {
  constructor(private providers: LLMProvider[]) {}

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    let lastError: Error | null = null;
    for (const provider of this.providers) {
      try {
        return await provider.chat(messages, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error("No providers in fallback chain");
  }
}

/**
 * Factory: wraps providers in a resilient + fallback chain.
 */
export function createResilientFallbackChain(providers: LLMProvider[]): LLMProvider {
  const wrapped = providers.map((p) =>
    p instanceof ResilientProvider ? p : new ResilientProvider(p),
  );
  return new FallbackChainProvider(wrapped);
}