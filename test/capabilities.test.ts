import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentCapabilities } from "../src/runtime/capabilities.js";
import type { AgentAdapter } from "../src/agents/synthesis/types.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("agent capability discovery", () => {
  it("separates Codex capture evidence from an unavailable synthesis CLI", async () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-cap-")); homes.push(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    const unavailable = (id: "claude-code" | "codex" | "opencode"): AgentAdapter => ({
      id, displayName: id, isAvailable: async () => false,
      invoke: async () => { throw new Error("must not invoke"); },
    });

    const capabilities = await discoverAgentCapabilities({ homeDir: home, verifySynthesis: true, adapterFactory: unavailable });
    expect(capabilities.find((c) => c.agent === "codex")).toMatchObject({ capture: "ready", synthesis: "unavailable", executable: false });
    expect(capabilities.find((c) => c.agent === "claude-code")).toMatchObject({ capture: "not_found", synthesis: "unavailable" });
  });

  it("marks synthesis ready only after the exact probe succeeds", async () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-cap-")); homes.push(home);
    const adapterFactory = (id: "claude-code" | "codex" | "opencode"): AgentAdapter => ({
      id, displayName: id, isAvailable: async () => true,
      invoke: async () => ({ text: id === "codex" ? "TERMYTE_AUTH_OK" : "login required", json: null, durationMs: 1 }),
    });
    const capabilities = await discoverAgentCapabilities({ homeDir: home, verifySynthesis: true, adapterFactory });
    expect(capabilities.find((c) => c.agent === "codex")?.synthesis).toBe("ready");
    expect(capabilities.find((c) => c.agent === "claude-code")?.synthesis).toBe("authentication_failed");
  });

  it("discovers OpenCode capture independently from synthesis verification", async () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-cap-")); homes.push(home);
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{}");
    const available = (id: "claude-code" | "codex" | "opencode"): AgentAdapter => ({
      id, displayName: id, isAvailable: async () => id === "opencode",
      invoke: async () => { throw new Error("must not invoke"); },
    });
    const capabilities = await discoverAgentCapabilities({ homeDir: home, adapterFactory: available });
    expect(capabilities.find((c) => c.agent === "opencode")).toMatchObject({ capture: "ready", synthesis: "unverified", executable: true });
  });
});
