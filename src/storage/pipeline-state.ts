import type { DB } from "./connection.js";
import type {
  MemoryLifecycleState,
  ObservationLifecycleState,
  TracePipelineState,
} from "../core/types.js";

export class PipelineStateStore {
  constructor(private readonly db: DB) {}

  updateTraceState(traceId: number, state: TracePipelineState): void {
    this.db.prepare(`
      UPDATE traces
      SET pipeline_state = @state
      WHERE id = @traceId
    `).run({ traceId, state });
  }

  markTraceProcessed(traceId: number, state: TracePipelineState = "memory_ready"): void {
    const nowMs = Date.now();
    this.db.prepare(`
      UPDATE traces
      SET processed_at = @nowMs, pipeline_state = @state
      WHERE id = @traceId
    `).run({ traceId, state, nowMs });
  }

  updateObservationState(observationId: number, state: ObservationLifecycleState): void {
    this.db.prepare(`
      UPDATE observations
      SET lifecycle_state = @state
      WHERE id = @observationId
    `).run({ observationId, state });
  }

  markObservationProcessed(observationId: number, state: ObservationLifecycleState = "indexed"): void {
    const nowMs = Date.now();
    this.db.prepare(`
      UPDATE observations
      SET processed_at = @nowMs, lifecycle_state = @state
      WHERE id = @observationId
    `).run({ observationId, state, nowMs });
  }

  updateMemoryState(memoryId: number, state: MemoryLifecycleState): void {
    const memoryState = state === "active" || state === "stale" || state === "superseded" ||
      state === "conflicted" || state === "deleted" ? state : undefined;
    this.db.prepare(`
      UPDATE memories
      SET lifecycle_state = @state,
          state = COALESCE(@memoryState, state)
      WHERE id = @memoryId
    `).run({ memoryId, state, memoryState: memoryState ?? null });
  }
}
