import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { TaskStateService } from "../tasks/service.js";
import { CheckpointService } from "../tasks/checkpoints.js";
import { ResumeCompiler } from "../tasks/resume.js";
import type { Platform } from "../shared/types.js";

type Options = Record<string, string | boolean>;

export async function taskCommand(action: string | undefined, options: Options): Promise<number> {
  const config = loadConfig(); const store = new Store(config.dbPath);
  try {
    const state = new TaskStateService(store.getDB());
    if (action === "create") {
      const repoId = required(options, "repo"); const title = required(options, "title"); const objective = required(options, "objective");
      print(state.createTask({ repoId, title, objective })); return 0;
    }
    const taskId = required(options, "task");
    if (action === "show") { print(new ResumeCompiler(store.getDB()).compile(taskId)); return 0; }
    if (action === "add-step") {
      print(state.addStep({ taskId, title: required(options, "title"), position: integer(options, "position"), expectedVersion: integer(options, "version"), verificationType: optional(options, "verification") })); return 0;
    }
    if (action === "verify-step") {
      if (required(options, "confirm").toLowerCase() !== "yes") throw new Error("--confirm yes is required for user verification");
      const evidence = state.recordEvidence({ taskId, kind: "user", verdict: "passed", payload: { confirmation: "yes" } });
      print(state.updateStep({ taskId, stepId: required(options, "step"), status: "verified", expectedVersion: integer(options, "version"), evidenceIds: [evidence.id], actor: "user", reason: "explicit CLI confirmation" })); return 0;
    }
    if (action === "checkpoint") {
      print(new CheckpointService(store.getDB()).create({ taskId, workspaceRoot: required(options, "workspace"), platform: platform(options, "platform"), sessionId: optional(options, "session") })); return 0;
    }
    if (action === "resume") { print(new ResumeCompiler(store.getDB()).compile(taskId, optional(options, "workspace"))); return 0; }
    if (action === "handoff") {
      print(new ResumeCompiler(store.getDB()).handoff({ taskId, source: platform(options, "source"), target: platform(options, "target"), workspaceRoot: optional(options, "workspace") })); return 0;
    }
    process.stderr.write("usage: termyte task <create|show|add-step|verify-step|checkpoint|resume|handoff> [options]\n"); return 2;
  } finally { store.close(); }
}

function required(options: Options, name: string): string { const value = options[name]; if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`); return value.trim(); }
function optional(options: Options, name: string): string | undefined { const value = options[name]; return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function integer(options: Options, name: string): number { const value = Number(required(options, name)); if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer`); return value; }
function platform(options: Options, name: string): Platform { const value = required(options, name); if (value !== "claude-code" && value !== "codex" && value !== "opencode" && value !== "raw") throw new Error(`--${name} must be claude-code, codex, opencode, or raw`); return value; }
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
