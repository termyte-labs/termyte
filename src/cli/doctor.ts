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
  expectedHooks: string[];
  installedHooks: string[];
  missingHooks: string[];
};

const EXPECTED_HOOKS = [
  "SessionStart:session-init",
  "UserPromptSubmit:context",
  "PostToolUse:observation",
  "Stop:summarize",
];

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const health = store.getHealthDiagnostics();
    const effects = effectSummary(store);
    const integrations = inspectIntegrations();
    const lines = [
      "Termyte Doctor",
      `db:                ${config.dbPath}`,
      `hook entry:         ${getTermyteHookPath() ?? "(missing)"}`,
      `synthesis:          ${config.synthesis.mode}`,
      `queue:              pending=${health.queue.pending} ready=${health.queue.ready} leased=${health.queue.leased} dead=${health.queue.dead}`,
      `queue age:          ${health.queue.oldestReadyAgeMs ?? 0}ms; completed last minute=${health.queue.completedLastMinute}`,
      `unprocessed traces: ${store.getUnprocessedTraces(1000).length}`,
      `context effects:    helped=${effects.helped} hurt=${effects.hurt} unused=${effects.unused} unknown=${effects.unknown}`,
      `attribution rate:   ${(effects.attributionRate * 100).toFixed(1)}%`,
      "",
      "Integrations:",
      ...integrations.map((entry) => {
        const status = entry.installed ? "installed" : entry.installedHooks.length > 0 ? "partial" : "missing";
        const missing = entry.missingHooks.length > 0 ? `; missing ${entry.missingHooks.join(", ")}` : "";
        return `  ${entry.name}: ${status} (${entry.evidence ?? entry.expectedPaths[0] ?? "n/a"}${missing})`;
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
    const installedHooks = new Set<string>();
    let evidence: string | undefined;
    for (const p of cfg.paths) {
      if (!existsSync(p)) continue;
      try {
        const text = readFileSync(p, "utf-8");
        for (const hook of readManagedHookCoverage(text, cfg.name === "Codex" ? "codex" : "claude-code")) installedHooks.add(hook);
        if (!evidence && (text.includes(cfg.needle) || installedHooks.size > 0)) evidence = p;
      } catch {
        // keep scanning other paths
      }
    }
    const installed = EXPECTED_HOOKS.filter((hook) => installedHooks.has(hook));
    const missing = EXPECTED_HOOKS.filter((hook) => !installedHooks.has(hook));
    return {
      name: cfg.name, expectedPaths: cfg.paths, installed: missing.length === 0, evidence,
      expectedHooks: [...EXPECTED_HOOKS], installedHooks: installed, missingHooks: missing,
    };
  });
}

function readManagedHookCoverage(text: string, agent: "claude-code" | "codex"): string[] {
  try {
    const parsed = JSON.parse(text) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    const found: string[] = [];
    for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) for (const hook of group.hooks ?? []) {
        if (!isTermyteHookCommand(hook.command) || !hook.command?.includes(` ${agent} `)) continue;
        for (const expected of EXPECTED_HOOKS) {
          const [expectedEvent, handler] = expected.split(":");
          if (event === expectedEvent && hook.command.includes(` ${handler}`)) found.push(expected);
        }
      }
    }
    return found;
  } catch {
    return [];
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
    const effects = effectSummary(store);
    process.stdout.write(JSON.stringify({
      dbPath: config.dbPath,
      hookEntry: getTermyteHookPath(),
      synthesis: config.synthesis.mode,
      queue: health.queue,
      unprocessedTraces: store.getUnprocessedTraces(1000).length,
      integrations: inspectIntegrations(),
      effects,
    }, null, 2) + "\n");
  } finally {
    store.close();
  }
}

function effectSummary(store: Store): Record<string, number> {
  const counts = store.getRecentContextEffectCounts(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  return {
    ...counts,
    attributionRate: counts.total === 0 ? 0 : (counts.total - counts.unknown) / counts.total,
    helpfulRate: counts.total === 0 ? 0 : counts.helped / counts.total,
    harmfulRate: counts.total === 0 ? 0 : counts.hurt / counts.total,
  };
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
