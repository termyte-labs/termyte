/**
 * Integration test for the OpenCodeAdapter. Two paths:
 *   1. HTTP server mode: spin up a local `http.createServer` that
 *      mimics opencode serve's endpoints, point OPENCODE_URL at it,
 *      and assert the adapter uses POST /session + POST /message.
 *   2. CLI fallback: when the server is unreachable, spawn the
 *      `opencode` binary (a fake one in a temp dir) and assert the
 *      adapter parses its stdout.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

let server: Server | null = null;
let serverUrl: string | null = null;
let originalOpenCodeUrl: string | undefined;
let originalOpenCodePath: string | undefined;

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "GET" && req.url === "/session") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{ id: "old" }]));
          return;
        }
        if (req.method === "POST" && req.url === "/session") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "new-session-1" }));
          return;
        }
        if (req.method === "POST" && req.url === "/session/new-session-1/message") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            parts: [{ type: "text", text: "<skip_summary />" }],
          }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = (server!.address() as AddressInfo);
      serverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

beforeEach(async () => {
  await startMockServer();
  originalOpenCodeUrl = process.env.OPENCODE_URL;
  process.env.OPENCODE_URL = serverUrl!;
});

afterEach(async () => {
  if (originalOpenCodeUrl === undefined) delete process.env.OPENCODE_URL;
  else process.env.OPENCODE_URL = originalOpenCodeUrl;
  if (originalOpenCodePath === undefined) delete process.env.OPENCODE_PATH;
  else process.env.OPENCODE_PATH = originalOpenCodePath;
  await stopMockServer();
});

describe("OpenCodeAdapter (server mode)", () => {
  it("isAvailable returns true when the server is reachable", async () => {
    const { OpenCodeAdapter } = await import("../src/synth/opencode.js");
    const a = new OpenCodeAdapter();
    expect(await a.isAvailable()).toBe(true);
  });

  it("invoke posts to /session then /message and returns the text", async () => {
    const { OpenCodeAdapter } = await import("../src/synth/opencode.js");
    const a = new OpenCodeAdapter();
    const result = await a.invoke("synthesize", { timeoutMs: 10_000 });
    expect(result.text).toBe("<skip_summary />");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("OpenCodeAdapter (CLI fallback)", () => {
  it("falls back to the CLI when no server is reachable", async () => {
    // Stop the mock server, point at a fake opencode binary, clear
    // the env so the resolver picks up OPENCODE_PATH.
    await stopMockServer();
    server = null;
    process.env.OPENCODE_URL = "http://127.0.0.1:1"; // unreachable
    const dir = mkdtempSync(join(tmpdir(), "termyte-oc-"));
    let fakeBin: string;
    if (process.platform === "win32") {
      fakeBin = join(dir, "opencode.cmd");
      writeFileSync(fakeBin, "@echo off\r\necho {\"text\":\"<skip_summary />\"}\r\n", "utf-8");
    } else {
      fakeBin = join(dir, "opencode");
      writeFileSync(fakeBin, "#!/bin/sh\ncat >/dev/null\necho '{\"text\":\"<skip_summary />\"}'\n", "utf-8");
      try { require("node:fs").chmodSync(fakeBin, 0o755); } catch { /* ignore */ }
    }
    originalOpenCodePath = process.env.OPENCODE_PATH;
    process.env.OPENCODE_PATH = fakeBin;

    // Re-import to reset the resolve cache so the new OPENCODE_PATH
    // is picked up.
    const { OpenCodeAdapter } = await import("../src/synth/opencode.js?reset=2");
    const a = new OpenCodeAdapter();
    // The ping is cached on the class instance, so this is a fresh
    // check.
    expect(await a.isAvailable()).toBe(true);
    const result = await a.invoke("synthesize", { timeoutMs: 10_000 });
    expect(result.text).toContain("<skip_summary />");
    rmSync(dir, { recursive: true, force: true });
  });
});
