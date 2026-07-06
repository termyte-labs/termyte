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
import { Store } from "../storage/store.js";
import { getTermyteHookPath, getTermyteMcpPath } from "../integrations/install-paths.js";
import { detectWorkspaceRoot } from "../retrieval/local-embeddings.js";

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
    const workspaceRoot = detectWorkspaceRoot(process.cwd());
    const sharedContextPath = join(workspaceRoot, ".termyte", "share", "context.md");
    const sharedContextStatus = existsSync(sharedContextPath) ? "present" : "missing";
    const lines = [
      "Termyte Doctor",
      `db:                ${config.dbPath}`,
      `hook entry:         ${getTermyteHookPath() ?? "(missing)"}`,
      `mcp entry:          ${getTermyteMcpPath() ?? "(missing)"}`,
      `shared context:     ${sharedContextStatus} (${sharedContextPath})`,
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
      `  - run \`termyte start\` to generate a portable shared context`,
      `  - run \`termyte install <platform>\` for missing integrations`,
      `  - run \`termyte health\` to inspect queue recovery`,
      `  - run \`termyte stats\` to confirm capture is flowing`,
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
    { name: "Cursor", paths: [join(home, ".cursor", "hooks.json"), join(cwd, ".cursor", "hooks.json")], needle: "termyte-hook cursor" },
    { name: "Gemini CLI", paths: [join(home, ".gemini", "settings.json")], needle: "termyte-hook gemini-cli" },
    { name: "Windsurf", paths: [join(home, ".codeium", "windsurf", "hooks.json")], needle: "termyte-hook windsurf" },
    { name: "OpenCode", paths: [join(home, ".config", "opencode", "opencode.json")], needle: "termyte.js" },
  ];

  return configs.map((cfg) => {
    for (const p of cfg.paths) {
      if (!existsSync(p)) continue;
      try {
        const text = readFileSync(p, "utf-8");
        if (text.includes(cfg.needle)) {
          return { name: cfg.name, expectedPaths: cfg.paths, installed: true, evidence: p };
        }
      } catch {
        // keep scanning other paths
      }
    }
    return { name: cfg.name, expectedPaths: cfg.paths, installed: false };
  });
}

export async function runMain(): Promise<void> {
  await main();
}

export async function runDoctorJson(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const health = store.getHealthDiagnostics();
    const sharedContextPath = join(detectWorkspaceRoot(process.cwd()), ".termyte", "share", "context.md");
    process.stdout.write(JSON.stringify({
      dbPath: config.dbPath,
      hookEntry: getTermyteHookPath(),
      mcpEntry: getTermyteMcpPath(),
      sharedContextPath,
      sharedContextPresent: existsSync(sharedContextPath),
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
