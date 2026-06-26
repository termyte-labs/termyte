/**
 * Install a termyte MCP server entry in the IDE's JSON config. No
 * transcript capture — these IDEs don't expose hooks, only MCP. The
 * IDE gets `search_memories`, `get_memory`, `get_recent_sessions`
 * tools so the agent can pull prior context on demand.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getNodeAbsolutePath, getTermyteMcpPath } from "../install-paths.js";
import type { McpInstallerConfig, McpJsonConfig } from "../types.js";

const PLACEHOLDER_CONTEXT = `# termyte: Cross-Session Memory

*No context yet. Complete your first session and context will appear here.*

Use termyte's MCP search tools for manual memory queries.`;

function buildMcpServerEntry(mcpServerPath: string): { command: string; args: string[] } {
  return { command: getNodeAbsolutePath(), args: [mcpServerPath] };
}

function writeMcpJsonConfig(configFilePath: string, mcpServerPath: string, serversKeyName: "mcpServers" | "servers"): number {
  const parentDirectory = dirname(configFilePath);
  mkdirSync(parentDirectory, { recursive: true });

  const existing: McpJsonConfig = existsSync(configFilePath)
    ? safeReadJson(configFilePath) : {};
  if (!existing[serversKeyName]) existing[serversKeyName] = {};
  existing[serversKeyName]!.termyte = buildMcpServerEntry(mcpServerPath);

  writeFileSync(configFilePath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  process.stdout.write(`termyte: wrote MCP config to ${configFilePath}\n`);
  return 0;
}

function safeReadJson(p: string): McpJsonConfig {
  try { return JSON.parse(readFileSync(p, "utf-8")) as McpJsonConfig; }
  catch { return {}; }
}

function buildMcpInstallers(home: string): Record<string, McpInstallerConfig> {
  return {
    "copilot-cli": {
      ideId: "copilot-cli",
      ideLabel: "Copilot CLI",
      configPath: join(home, ".github", "copilot", "mcp.json"),
      configKey: "servers",
    },
    "antigravity": {
      ideId: "antigravity",
      ideLabel: "Antigravity",
      configPath: join(home, ".gemini", "antigravity", "mcp_config.json"),
      configKey: "mcpServers",
    },
    "roo-code": {
      ideId: "roo-code",
      ideLabel: "Roo Code",
      configPath: join(process.cwd(), ".roo", "mcp.json"),
      configKey: "mcpServers",
    },
    "warp": {
      ideId: "warp",
      ideLabel: "Warp",
      configPath: join(home, ".warp", "mcp.json"),
      configKey: "mcpServers",
    },
  };
}

export function listMcpInstallerIds(): string[] {
  return [...Object.keys(buildMcpInstallers("/")), "goose"];
}

export function installMcpOnly(ide: string, homeDirOverride?: string): number {
  const home = homeDirOverride ?? homedir();
  if (ide === "goose") {
    return installGooseMcp(home);
  }
  const installers = buildMcpInstallers(home);
  const cfg = installers[ide];
  if (!cfg) {
    process.stderr.write(`termyte: unknown MCP-only IDE '${ide}'. Try: ${listMcpInstallerIds().join(", ")}.\n`);
    return 1;
  }
  const mcpServerPath = getTermyteMcpPath();
  if (!mcpServerPath) {
    process.stderr.write("termyte: could not locate the termyte-mcp server script.\n");
    process.stderr.write("  Build the project first (npm run build) or set TERMYTE_MCP_PATH.\n");
    return 1;
  }
  return writeMcpJsonConfig(cfg.configPath, mcpServerPath, cfg.configKey);
}

function installGooseMcp(home: string): number {
  const mcpServerPath = getTermyteMcpPath();
  if (!mcpServerPath) {
    process.stderr.write("termyte: could not locate the termyte-mcp server script.\n");
    return 1;
  }
  const configPath = join(home, ".config", "goose", "config.yaml");
  mkdirSync(dirname(configPath), { recursive: true });
  const node = getNodeAbsolutePath();
  const block = [
    "extensions:",
    "  termyte:",
    `    command: ${node}`,
    "    args:",
    `      - ${mcpServerPath}`,
    "",
  ].join("\n");
  writeFileSync(configPath, block, "utf-8");
  process.stdout.write(`termyte: wrote Goose MCP config to ${configPath}\n`);
  return 0;
}
