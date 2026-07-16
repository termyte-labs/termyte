import type { NormalizedEvent } from "../capture/adapter.js";
import type { Session, Trace, EvidenceKind } from "../core/types.js";
import type { Store } from "../storage/store.js";
import { readGitDiffState, readGitHead } from "./git-state.js";

/**
 * Deterministically groups captured traces into task episodes and extracts
 * observable evidence. LLM-derived interpretation belongs downstream.
 */
export class ExperienceRecorder {
  constructor(private readonly store: Store) {}

  record(event: NormalizedEvent, trace: Trace, session: Session): string | null {
    let episode = this.store.getActiveEpisode(event.session_id);

    if (event.event_type === "user_prompt" && (!episode || this.startsNewEpisode(episode.id, event.user_prompt))) {
      if (episode) {
        const status = inferTerminalStatus(event, this.store.getEvidenceForEpisode(episode.id));
        this.finalizeEpisode(event.session_id, status, event.timestamp);
      }
      const workspaceRoot = session.workspace_root ?? event.cwd;
      episode = this.store.startEpisode({
        sessionId: event.session_id,
        repoId: session.repo_id ?? "unknown",
        workspaceRoot,
        task: cleanText(event.user_prompt) || "Untitled coding task",
        baseCommit: readGitHead(workspaceRoot),
        nowMs: event.timestamp,
      });
    } else if (!episode && event.event_type !== "session_init") {
      const workspaceRoot = session.workspace_root ?? event.cwd;
      episode = this.store.startEpisode({
        sessionId: event.session_id,
        repoId: session.repo_id ?? "unknown",
        workspaceRoot,
        task: cleanText(event.user_prompt) || "Agent session",
        baseCommit: readGitHead(workspaceRoot),
        nowMs: event.timestamp,
      });
    }

    if (!episode) return null;
    this.store.linkTraceToEpisode(episode.id, trace.id);
    for (const evidence of evidenceFrom(event)) {
      this.store.insertEvidence({
        episodeId: episode.id,
        kind: evidence.kind,
        content: evidence.content,
        exitCode: evidence.exitCode,
        metadata: evidence.metadata,
        traceIds: [trace.id],
        observedAt: event.timestamp,
      });
    }

    if (event.event_type === "assistant_message" && event.final_response) {
      const status = inferTerminalStatus(event, this.store.getEvidenceForEpisode(episode.id));
      this.finalizeEpisode(event.session_id, status, event.timestamp);
    } else if (event.event_type === "session_end") {
      const status = inferTerminalStatus(event, this.store.getEvidenceForEpisode(episode.id));
      this.finalizeEpisode(event.session_id, status, event.timestamp);
      this.store.endSession(event.session_id);
    }
    return episode.id;
  }

  private startsNewEpisode(episodeId: string, prompt: string | null): boolean {
    const failedEvidence = this.store.getEvidenceForEpisode(episodeId)
      .some((evidence) => evidence.exit_code !== null && evidence.exit_code !== 0);
    const separateTask = /^(?:new|another|separate|switch(?:ing)?|next)\s+(?:task|issue|problem)/i.test(cleanText(prompt));
    return failedEvidence || separateTask;
  }

  private finalizeEpisode(sessionId: string, status: "succeeded" | "failed" | "unknown", nowMs: number): void {
    const episode = this.store.getActiveEpisode(sessionId);
    if (!episode) return;
    const git = readGitDiffState(episode.workspace_root);
    if (git && git.changedPaths.length > 0) {
      this.store.insertEvidence({
        episodeId: episode.id,
        kind: "diff",
        content: git.changedPaths.join("\n"),
        metadata: {
          changed_paths: git.changedPaths,
          staged_paths: git.stagedPaths,
          unstaged_paths: git.unstagedPaths,
          staged_stat: git.stagedStat,
          unstaged_stat: git.unstagedStat,
        },
        observedAt: nowMs,
      });
    }
    this.store.closeActiveEpisode(sessionId, status, nowMs, git?.head ?? null);
    this.store.recordEpisodeOutcome({
      episodeId: episode.id,
      status,
      source: "inferred",
      contextInjectionId: this.store.getLatestContextInjectionForEpisode(episode.id)?.id ?? null,
      nowMs,
    });
  }
}

interface EvidenceInput {
  kind: EvidenceKind;
  content: string;
  exitCode: number | null;
  metadata: Record<string, unknown>;
}

function evidenceFrom(event: NormalizedEvent): EvidenceInput[] {
  const out: EvidenceInput[] = [];
  const command = readCommand(event.tool_input);
  if (command) {
    out.push({
      kind: classifyCommand(command),
      content: command,
      exitCode: readExitCode(event.tool_output),
      metadata: { tool: event.tool_name, output: compactOutput(event.tool_output) },
    });
  }
  for (const file of [...(event.files_read ?? []), ...(event.files_modified ?? [])]) {
    out.push({
      kind: "file",
      content: file,
      exitCode: null,
      metadata: { modified: (event.files_modified ?? []).includes(file) },
    });
  }
  if (event.final_response) {
    out.push({
      kind: "agent_statement",
      content: cleanText(event.final_response),
      exitCode: null,
      metadata: {},
    });
  }
  return out;
}

function classifyCommand(command: string): EvidenceKind {
  if (/\b(?:test|vitest|jest|pytest|cargo\s+test|go\s+test|rspec)\b/i.test(command)) return "test";
  if (/\b(?:build|tsc|cargo\s+build|go\s+build|npm\s+pack)\b/i.test(command)) return "build";
  return "command";
}

function readCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string" && record[key]!.trim()) return record[key] as string;
  }
  return null;
}

function readExitCode(output: unknown): number | null {
  if (!output || typeof output !== "object") return null;
  const record = output as Record<string, unknown>;
  for (const key of ["exit_code", "exitCode", "code", "status"]) {
    if (typeof record[key] === "number") return record[key] as number;
    if (record[key] === "ok" || record[key] === "success") return 0;
    if (record[key] === "error" || record[key] === "failed") return 1;
  }
  return null;
}

function compactOutput(output: unknown): string | null {
  if (output == null) return null;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

function inferTerminalStatus(event: NormalizedEvent, evidence: Array<{ kind: EvidenceKind; exit_code: number | null }>): "succeeded" | "failed" | "unknown" {
  const exitCode = readExitCode(event.tool_output);
  if (exitCode === 0) return "succeeded";
  if (exitCode !== null) return "failed";
  const executable = evidence.filter((item) =>
    (item.kind === "command" || item.kind === "test" || item.kind === "build") && item.exit_code !== null,
  );
  const last = executable.at(-1)?.exit_code;
  if (last === 0) return "succeeded";
  if (last !== undefined && last !== null) return "failed";
  return "unknown";
}

function cleanText(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
