/**
 * `termyte smoke` — repeatable local proof that the core developer
 * loop is wired: inspect health, export shared context, and optionally
 * invoke a live agent adapter with a prompt.
 */
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { createAdapter, discoverAdapter, type AgentAdapterId } from "../synth/index.js";
import { AgentInvocationError } from "../synth/types.js";
import { detectRepoId, detectWorkspaceRoot } from "../retrieval/local-embeddings.js";
import { shareCommand } from "./share.js";
import { inspectIntegrations } from "./doctor.js";

export async function smokeCommand(options: {
  repo_id?: string;
  query?: string;
  limit?: number;
  currentFiles?: string[];
  type?: string;
  path?: string;
  adapter?: AgentAdapterId;
  prompt?: string;
  json?: boolean;
} = {}): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const workspaceRoot = detectWorkspaceRoot(process.cwd());
  const repoId = options.repo_id ?? detectRepoId(workspaceRoot);
  const sharedContextPath = options.path ?? join(workspaceRoot, ".termyte", "share", "context.md");

  try {
    const health = store.getHealthDiagnostics();
    const adapter = await discoverAdapter();
    const integrations = inspectIntegrations();
    await shareCommand({
      repo_id: repoId,
      query: options.query,
      limit: options.limit,
      currentFiles: options.currentFiles,
      type: options.type,
      path: sharedContextPath,
      silent: true,
    });

    const report: {
      dbPath: string;
      workspaceRoot: string;
      repoId: string | null;
      sharedContextPath: string;
      sharedContextPresent: boolean;
      health: { queue: ReturnType<typeof store.getHealthDiagnostics>["queue"]; unprocessedTraces: number };
      synthesisAdapter: string | null;
      integrations: ReturnType<typeof inspectIntegrations>;
      agentInvocation?: {
        adapter: string;
        prompt: string;
        text: string;
        model?: string;
        durationMs: number;
      };
      agentInvocationError?: {
        adapter: string;
        reason?: string;
        message: string;
        stderr?: string;
      };
    } = {
      dbPath: config.dbPath,
      workspaceRoot,
      repoId: repoId ?? null,
      sharedContextPath,
      sharedContextPresent: true,
      health: {
        queue: health.queue,
        unprocessedTraces: store.getUnprocessedTraces(1000).length,
      },
      synthesisAdapter: adapter ?? null,
      integrations,
    };

    if (options.prompt) {
      const invokeAdapterId = options.adapter ?? adapter ?? undefined;
      if (!invokeAdapterId) {
        throw new Error("no synthesis adapter found for smoke invocation");
      }
      const liveAdapter = createAdapter(invokeAdapterId);
      if (!await liveAdapter.isAvailable()) {
        throw new Error(`adapter '${invokeAdapterId}' is not available`);
      }
      try {
        const result = await liveAdapter.invoke(options.prompt, {
          cwd: workspaceRoot,
          timeoutMs: 60_000,
        });
        report.agentInvocation = {
          adapter: invokeAdapterId,
          prompt: options.prompt,
          text: result.text,
          model: result.model,
          durationMs: result.durationMs,
        };
      } catch (err) {
        if (err instanceof AgentInvocationError) {
          report.agentInvocationError = {
            adapter: invokeAdapterId,
            reason: err.reason,
            message: err.message,
            stderr: err.stderr,
          };
        } else {
          report.agentInvocationError = {
            adapter: invokeAdapterId,
            message: err instanceof Error ? err.message : String(err),
          };
        }
        if (options.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          return;
        }
        throw err;
      }
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }

    const lines = [
      "Termyte Smoke",
      `db:                  ${report.dbPath}`,
      `workspace root:      ${report.workspaceRoot}`,
      `repo id:             ${report.repoId ?? "(unknown)"}`,
      `shared context:      ${report.sharedContextPath}`,
      `synthesis adapter:   ${report.synthesisAdapter ?? "(none found)"}`,
      `queue:               pending=${report.health.queue.pending} leased=${report.health.queue.leased} dead=${report.health.queue.dead}`,
      `unprocessed traces:  ${report.health.unprocessedTraces}`,
    ];
    if (report.agentInvocation) {
      lines.push(
        `agent invocation:    ${report.agentInvocation.adapter} (${report.agentInvocation.durationMs}ms)`,
        `agent output:        ${report.agentInvocation.text.slice(0, 240)}`,
      );
    }
    lines.push(
      "",
      "Integrations:",
      ...report.integrations.map((entry) => `  ${entry.name}: ${entry.installed ? "installed" : "missing"}`),
      "",
      "Next steps:",
      `  - hand ${report.sharedContextPath} to another agent`,
      `  - run \`termyte doctor\` for a focused install check`,
      `  - run \`termyte stats\` after a session to confirm capture is flowing`,
    );
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    store.close();
  }
}
