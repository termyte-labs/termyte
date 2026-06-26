/**
 * `termyte mcp` — start the MCP stdio server. Each IDE that supports
 * MCP launches this command via the entry in its config file
 * (e.g. ~/.cursor/mcp.json, ~/.github/copilot/mcp.json).
 */
import { runMcpServer } from "../mcp/server.js";

runMcpServer().catch((err) => {
  process.stderr.write(`termyte-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
