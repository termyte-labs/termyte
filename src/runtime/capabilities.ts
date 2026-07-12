import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../synth/index.js";
import type { AgentAdapter } from "../synth/types.js";

export type SupportedAgent = "claude-code" | "codex";
export type CaptureCapability = "ready" | "found_unverified" | "not_found";
export type SynthesisCapability = "ready" | "unavailable" | "authentication_failed" | "unverified";

export interface AgentCapability {
  agent: SupportedAgent;
  capture: CaptureCapability;
  synthesis: SynthesisCapability;
  executable: boolean;
  evidence: string[];
  error?: string;
}

export async function discoverAgentCapabilities(options: {
  env?: NodeJS.ProcessEnv;
  verifySynthesis?: boolean;
  homeDir?: string;
  adapterFactory?: (agent: SupportedAgent) => AgentAdapter;
} = {}): Promise<AgentCapability[]> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? env.USERPROFILE ?? homedir();
  return Promise.all(((["claude-code", "codex"] as SupportedAgent[])).map(async (agent) => {
    const adapter = options.adapterFactory?.(agent) ?? createAdapter(agent);
    const executable = await adapter.isAvailable();
    const evidence = localEvidence(agent, home);
    const capture: CaptureCapability = evidence.length > 0
      ? "ready"
      : executable ? "found_unverified" : "not_found";

    if (!executable) {
      return { agent, capture, synthesis: "unavailable", executable, evidence };
    }
    if (!options.verifySynthesis) {
      return { agent, capture, synthesis: "unverified", executable, evidence };
    }
    try {
      const result = await adapter.invoke("Reply with exactly TERMYTE_AUTH_OK and nothing else.", {
        timeoutMs: 45_000,
        maxBudgetUsd: 0.01,
        cwd: process.cwd(),
      });
      if (result.text.trim() !== "TERMYTE_AUTH_OK") {
        return { agent, capture, synthesis: "authentication_failed", executable, evidence, error: "verification response did not match" };
      }
      return { agent, capture, synthesis: "ready", executable, evidence: [...evidence, "authenticated noninteractive invocation"] };
    } catch (error) {
      return {
        agent, capture, synthesis: "authentication_failed", executable, evidence,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

function localEvidence(agent: SupportedAgent, home: string): string[] {
  if (agent === "codex") {
    return [
      [join(home, ".codex", "auth.json"), "Codex authentication store"],
      [join(home, ".codex", "config.toml"), "Codex configuration"],
      [join(home, ".codex", ".codex-global-state.json"), "Codex application state"],
    ].filter(([path]) => existsSync(path!)).map(([, label]) => label!);
  }
  return [
    [join(home, ".claude", ".credentials.json"), "Claude Code authentication store"],
    [join(home, ".claude.json"), "Claude Code application state"],
  ].filter(([path]) => existsSync(path!)).map(([, label]) => label!);
}

export function capabilityLabel(capability: AgentCapability): string {
  const name = capability.agent === "codex" ? "Codex" : "Claude Code";
  if (capability.synthesis === "ready" && capability.capture === "ready") return `${name} (capture detected + authenticated synthesis)`;
  if (capability.synthesis === "ready") return `${name} (authenticated synthesis; capture installation unverified)`;
  if (capability.synthesis === "authentication_failed" && capability.capture === "ready") return `${name} (capture detected; authentication failed)`;
  if (capability.synthesis === "authentication_failed") return `${name} (executable found; authentication failed)`;
  if (capability.capture === "ready") return `${name} (capture detected; synthesis unavailable)`;
  if (capability.capture === "found_unverified") return `${name} (executable found; installation unverified)`;
  return `${name} (not detected)`;
}
