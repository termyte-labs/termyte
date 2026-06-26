/**
 * Install the termyte OpenCode plugin.
 *
 * Steps:
 *   1. Copy src/integrations/opencode-plugin/index.ts to
 *      ~/.config/opencode/plugins/termyte.js (or wherever the build
 *      output lives — we copy the source if the dist is missing so
 *      the plugin works even without a build, when OpenCode is run
 *      with a TS loader).
 *   2. Append the plugin path to `plugin` in
 *      ~/.config/opencode/opencode.json`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findTermyteProjectRoot } from "../install-paths.js";

const PLUGIN_REL_PATH = "./plugins/termyte.js";

function getOpenCodeConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
}

function getOpenCodePluginsDir(): string {
  return join(getOpenCodeConfigDir(), "plugins");
}

function getOpenCodeConfigPath(): string {
  return join(getOpenCodeConfigDir(), "opencode.json");
}

function resolvePluginSource(): string | null {
  const root = findTermyteProjectRoot();
  if (!root) return null;
  const candidates = [
    join(root, "dist", "integrations", "opencode-plugin", "index.js"),
    join(root, "src", "integrations", "opencode-plugin", "index.ts"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function getOpenCodePluginEntries(config: Record<string, unknown>): unknown[] {
  if (Array.isArray(config.plugin)) return config.plugin;
  if (config.plugin === undefined) return [];
  return [config.plugin];
}

export function installOpenCodePlugin(): number {
  const src = resolvePluginSource();
  if (!src) {
    process.stderr.write("termyte: could not locate the OpenCode plugin source. Run from a project root.\n");
    return 1;
  }

  const pluginsDir = getOpenCodePluginsDir();
  const dest = join(pluginsDir, "termyte.js");
  const configPath = getOpenCodeConfigPath();

  mkdirSync(pluginsDir, { recursive: true });
  copyFileSync(src, dest);
  process.stdout.write(`termyte: copied plugin to ${dest}\n`);

  // Update opencode.json: ensure `plugin` is an array containing our
  // relative path.
  const defaultConfig: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  const config: Record<string, unknown> = existsSync(configPath)
    ? safeReadJson(configPath) : defaultConfig;

  const existing = getOpenCodePluginEntries(config);
  if (!existing.includes(PLUGIN_REL_PATH)) {
    config.plugin = [...existing, PLUGIN_REL_PATH];
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  process.stdout.write(`termyte: registered plugin in ${configPath}\n`);
  process.stdout.write(`termyte: synthesis uses 'opencode run' (or 'opencode serve' HTTP if running).\n`);
  return 0;
}

function safeReadJson(p: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>; }
  catch { return {}; }
}
