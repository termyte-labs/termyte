/**
 * AgentAdapter — the single contract every synthesis-capable agent
 * implements. Termyte dispatches to one of these instead of owning an
 * LLM directly. See docs/background-memory-generation.md.
 *
 * An adapter wraps the agent's documented CLI/SDK and exposes a uniform
 * `invoke(prompt, opts)` method. Adapters are responsible for:
 *   - locating the agent's binary
 *   - honoring the budget cap (where the CLI supports it)
 *   - returning a structured AgentInvokeResult
 *   - respecting AbortSignal
 *
 * Adapters MUST NOT block on the user's active coding session. They
 * fork a subprocess or talk to a running server, but the call into
 * the adapter itself returns as soon as the model finishes.
 */

export type AgentAdapterId =
  | "claude-code"
  | "codex"
  | "fake";

export interface AgentInvokeOptions {
  /** Wall-clock timeout. Adapter MUST abort at or before this. */
  timeoutMs?: number;
  /** Per-invocation spend cap. Only Claude Code's CLI honors this. */
  maxBudgetUsd?: number;
  /** Optional JSON Schema for structured output. */
  jsonSchema?: Record<string, unknown>;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** The session this synthesis is tied to. Used for telemetry. */
  contextSessionId?: string;
  /** Working directory the agent should treat as project root. */
  cwd?: string;
}

export interface AgentInvokeUsage {
  input?: number;
  output?: number;
}

export interface AgentInvokeResult {
  text: string;
  /** Parsed JSON if the agent emitted valid JSON; null otherwise. */
  json: unknown | null;
  usage?: AgentInvokeUsage;
  model?: string;
  durationMs: number;
}

export class AgentInvocationError extends Error {
  constructor(
    public readonly reason:
      | "not_available"
      | "timeout"
      | "cancelled"
      | "rate_limited"
      | "non_zero_exit"
      | "invalid_output"
      | "internal",
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "AgentInvocationError";
  }
}

export interface AgentAdapter {
  readonly id: AgentAdapterId;
  /** Returns true if the underlying CLI/SDK is callable. */
  isAvailable(): Promise<boolean>;
  /**
   * Run a one-shot synthesis prompt. The adapter handles the
   * subprocess/SDK call and returns the model's response. Must
   * never throw for user-recoverable errors — wrap them as
   * AgentInvocationError instead.
   */
  invoke(prompt: string, opts?: AgentInvokeOptions): Promise<AgentInvokeResult>;
  /** Optional human-readable label for diagnostics and banners. */
  readonly displayName: string;
}
