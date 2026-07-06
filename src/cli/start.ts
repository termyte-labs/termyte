/**
 * `termyte start` — one-command onboarding for a new repo.
 *
 * The command combines a local health snapshot with a portable
 * shared-context export so a developer can immediately try the
 * cross-agent memory loop.
 */
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { discoverAdapter } from "../synth/index.js";
import { inspectIntegrations } from "./doctor.js";
import { shareCommand } from "./share.js";
import { detectRepoId, detectWorkspaceRoot } from "../retrieval/local-embeddings.js";

export async function startCommand(options: {
  repo_id?: string;
  query?: string;
  limit?: number;
  currentFiles?: string[];
  type?: string;
  path?: string;
  json?: boolean;
} = {}): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const workspaceRoot = detectWorkspaceRoot(process.cwd());
  const sharePath = options.path ?? join(workspaceRoot, ".termyte", "share", "context.md");
  const repo_id = options.repo_id ?? detectRepoId(workspaceRoot);

  try {
    const health = store.getHealthDiagnostics();
    const adapter = await discoverAdapter();
    const integrations = inspectIntegrations();

    await shareCommand({
      repo_id,
      query: options.query,
      limit: options.limit,
      currentFiles: options.currentFiles,
      type: options.type,
      path: sharePath,
      json: options.json,
      silent: options.json,
    });

    const lines = [
      "Termyte Start",
      `db:                  ${config.dbPath}`,
      `synthesis adapter:   ${adapter ?? "(none found)"}`,
      `queue:               pending=${health.queue.pending} leased=${health.queue.leased} dead=${health.queue.dead}`,
      `unprocessed traces:  ${store.getUnprocessedTraces(1000).length}`,
      `shared context:      ${sharePath}`,
      "",
      "Integrations:",
      ...integrations.map((entry) => {
        const status = entry.installed ? "installed" : "missing";
        return `  ${entry.name}: ${status}`;
      }),
      "",
      "Next steps:",
      `  - open the shared context file in another agent: ${sharePath}`,
      `  - run \`termyte doctor\` for a focused install check`,
      `  - run \`termyte stats\` after a session to confirm capture is flowing`,
    ];
    if (options.json) {
      process.stdout.write(JSON.stringify({
        dbPath: config.dbPath,
        synthesisAdapter: adapter,
        queue: health.queue,
        unprocessedTraces: store.getUnprocessedTraces(1000).length,
        sharedContextPath: sharePath,
        repoId: repo_id ?? null,
        workspaceRoot,
        integrations,
      }, null, 2) + "\n");
    } else {
      process.stdout.write(lines.join("\n") + "\n");
    }
  } finally {
    store.close();
  }
}
