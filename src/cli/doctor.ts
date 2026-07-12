/**
 * `termyte doctor` — report whether Termyte is installed and wired
 * correctly for the current machine. This is a local-only quick
 * diagnosis command for onboarding and support.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { isTermyteHookCommand } from "../integrations/installers/managed-hooks.js";
import { Store } from "../storage/store.js";
import { getTermyteHookPath } from "../integrations/install-paths.js";

type IntegrationStatus = {
  name: string;
  expectedPaths: string[];
  installed: boolean;
  evidence?: string;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const health = store.getHealthDiagnostics();
    const integrations = inspectIntegrations();
    const lines = [
      "Termyte Doctor",
      `db:                ${config.dbPath}`,
      `hook entry:         ${getTermyteHookPath() ?? "(missing)"}`,
      `synthesis:          ${config.synthesis.mode}`,
      `queue:              pending=${health.queue.pending} leased=${health.queue.leased} dead=${health.queue.dead}`,
      `unprocessed traces: ${store.getUnprocessedTraces(1000).length}`,
      "",
      "Integrations:",
      ...integrations.map((entry) => {
        const status = entry.installed ? "installed" : "missing";
        return `  ${entry.name}: ${status} (${entry.evidence ?? entry.expectedPaths[0] ?? "n/a"})`;
      }),
      "",
      "Next steps:",
      `  - run \`termyte init\` to change integrations or synthesis`,
      `  - run \`termyte viewer\` to inspect captured experience`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    store.close();
  }
}

export function inspectIntegrations(): IntegrationStatus[] {
  const home = homedir();
  const cwd = process.cwd();
  const configs: Array<{ name: string; paths: string[]; needle: string }> = [
    { name: "Claude Code", paths: [join(home, ".claude", "settings.json"), join(cwd, ".claude", "settings.json")], needle: "termyte-hook claude-code" },
    { name: "Codex", paths: [join(home, ".codex", "hooks.json"), join(cwd, ".codex", "hooks.json")], needle: "termyte-hook codex" },
  ];

  return configs.map((cfg) => {
    for (const p of cfg.paths) {
      if (!existsSync(p)) continue;
      try {
        const text = readFileSync(p, "utf-8");
        if (text.includes(cfg.needle) || hasManagedAgentHook(text, cfg.name === "Codex" ? "codex" : "claude-code")) {
          return { name: cfg.name, expectedPaths: cfg.paths, installed: true, evidence: p };
        }
      } catch {
        // keep scanning other paths
      }
    }
    return { name: cfg.name, expectedPaths: cfg.paths, installed: false };
  });
}

function hasManagedAgentHook(text: string, agent: "claude-code" | "codex"): boolean {
  try {
    const parsed = JSON.parse(text) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    return Object.values(parsed.hooks ?? {}).some((groups) =>
      Array.isArray(groups) && groups.some((group) =>
        group.hooks?.some((hook) => isTermyteHookCommand(hook.command) && hook.command?.includes(` ${agent} `)),
      ),
    );
  } catch {
    return false;
  }
}

export async function runMain(): Promise<void> {
  await main();
}

export async function runDoctorJson(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const health = store.getHealthDiagnostics();
    process.stdout.write(JSON.stringify({
      dbPath: config.dbPath,
      hookEntry: getTermyteHookPath(),
      synthesis: config.synthesis.mode,
      queue: health.queue,
      unprocessedTraces: store.getUnprocessedTraces(1000).length,
      integrations: inspectIntegrations(),
    }, null, 2) + "\n");
  } finally {
    store.close();
  }
}

function isMainEntry(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main().catch((err) => {
    process.stderr.write(`termyte: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
