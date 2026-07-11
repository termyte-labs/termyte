import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFor } from "../src/integrations/installers/index.js";

// DOC-001: installer output must not claim automatic synthesis or memory
// availability that the installed commands do not perform. These phrases are
// the unsupported claims that were removed.
const FORBIDDEN_CLAIMS = [
  "will run automatically",
  "automatically on session end",
  "will appear here",
  "injected automatically",
  "synthesis will run automatically",
];

let homeDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalHook: string | undefined;
let originalMcp: string | undefined;
let originalCwd: string;
let originalOcCfg: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "termyte-claims-"));
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalHook = process.env.TERMYTE_HOOK_PATH;
  originalMcp = process.env.TERMYTE_MCP_PATH;
  originalOcCfg = process.env.OPENCODE_CONFIG_DIR;
  const projectRoot = process.cwd();
  process.env.TERMYTE_HOOK_PATH = join(projectRoot, "dist", "cli", "hook.js");
  if (!existsSync(process.env.TERMYTE_HOOK_PATH)) {
    process.env.TERMYTE_HOOK_PATH = join(projectRoot, "src", "cli", "hook.ts");
  }
  process.env.TERMYTE_MCP_PATH = join(projectRoot, "dist", "mcp", "server.js");
  if (!existsSync(process.env.TERMYTE_MCP_PATH)) {
    process.env.TERMYTE_MCP_PATH = join(projectRoot, "src", "mcp", "server.ts");
  }
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.OPENCODE_CONFIG_DIR = join(homeDir, ".config", "opencode");
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalHook === undefined) delete process.env.TERMYTE_HOOK_PATH;
  else process.env.TERMYTE_HOOK_PATH = originalHook;
  if (originalMcp === undefined) delete process.env.TERMYTE_MCP_PATH;
  else process.env.TERMYTE_MCP_PATH = originalMcp;
  if (originalOcCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOcCfg;
  rmSync(homeDir, { recursive: true, force: true });
});

function captureInstallStdout(platform: string, opts: Record<string, unknown>): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c).toString());
    return true;
  });
  try {
    installFor(platform, opts);
    return chunks.join("");
  } finally {
    spy.mockRestore();
  }
}

describe("DOC-001 installer message truthfulness", () => {
  it("claude-code describes the silent viewer-first runtime", () => {
    const out = captureInstallStdout("claude-code", { target: "user", homeDir });
    for (const claim of FORBIDDEN_CLAIMS) expect(out).not.toContain(claim);
    expect(out).toContain("capture and context run silently");
    expect(out).toContain("termyte viewer");
  });

  it("codex describes the silent viewer-first runtime", () => {
    const out = captureInstallStdout("codex", { target: "user", homeDir });
    for (const claim of FORBIDDEN_CLAIMS) expect(out).not.toContain(claim);
    expect(out).toContain("capture and context run silently");
    expect(out).toContain("termyte viewer");
  });
});
