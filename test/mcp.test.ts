import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMcpInstallConfig, handleMcpRequest } from "../src/mcp.js";

function workspace(): { cwd: string; dbPath: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-mcp-"));
  return { cwd, dbPath: path.join(cwd, "termyte.db") };
}

function parseResponse(raw: string | null): { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { message: string } } {
  expect(raw).toBeTruthy();
  return JSON.parse(raw ?? "{}") as { result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { message: string } };
}

describe("Termyte MCP server", () => {
  it("lists governed coding-agent tools", async () => {
    const { cwd, dbPath } = workspace();
    const response = parseResponse(await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, cwd, dbPath));

    expect(response.result?.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "termyte.git.status",
      "termyte.fs.write",
      "termyte.shell.run",
      "termyte.policy.explain",
      "termyte.runtime.prove",
    ]));
  });

  it("explains blocked commands without executing them", async () => {
    const { cwd, dbPath } = workspace();
    const response = parseResponse(await handleMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "termyte.policy.explain",
        arguments: { command: "git push --force origin main" },
      },
    }, cwd, dbPath));
    const payload = JSON.parse(response.result?.content?.[0]?.text ?? "{}") as { finalDecision: string; semanticId: string };

    expect(payload.finalDecision).toBe("block");
    expect(payload.semanticId).toBe("git.push.force");
  });

  it("allows ordinary workspace writes through the runtime and ledger", async () => {
    const { cwd, dbPath } = workspace();
    const target = path.join(cwd, "agent-output.txt");
    const response = parseResponse(await handleMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "termyte.fs.write",
        arguments: { path: target, content: "hello" },
      },
    }, cwd, dbPath));
    const payload = JSON.parse(response.result?.content?.[0]?.text ?? "{}") as { decision: string; wasExecuted: boolean; ledgerId: number };

    expect(payload.decision).toBe("allow");
    expect(payload.wasExecuted).toBe(true);
    expect(payload.ledgerId).toBeGreaterThan(0);
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
  });

  it("builds MCP config with a fixed Termyte workspace", () => {
    const { cwd } = workspace();
    const config = buildMcpInstallConfig(cwd) as { mcpServers?: { termyte?: { command?: string; args?: string[]; env?: { TERMYTE_WORKSPACE?: string } } } };

    expect(config.mcpServers?.termyte?.command).toBe(process.execPath);
    expect(config.mcpServers?.termyte?.args).toEqual(expect.arrayContaining(["mcp", "serve"]));
    expect(config.mcpServers?.termyte?.env?.TERMYTE_WORKSPACE).toBe(path.resolve(cwd));
  });
});
