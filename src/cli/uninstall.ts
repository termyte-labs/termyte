import { checkbox, confirm } from "@inquirer/prompts";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, termyteHome } from "./config.js";
import { removeTermyteHookEntries } from "../integrations/installers/managed-hooks.js";
import { uninstallOpenCode } from "../integrations/installers/opencode.js";

type Removal = "claude-code" | "codex" | "opencode" | "data";

export async function uninstallCommand(): Promise<number> {
  const selected = await checkbox<Removal>({
    message: "Select what Termyte should remove",
    choices: [
      { name: "Claude Code integration", value: "claude-code", checked: true },
      { name: "Codex integration", value: "codex", checked: true },
      { name: "OpenCode integration", value: "opencode", checked: true },
      { name: "Local Termyte data and configuration", value: "data" },
    ],
  });
  if (selected.includes("data")) {
    const accepted = await confirm({ message: "Permanently delete all local Termyte data?", default: false });
    if (!accepted) selected.splice(selected.indexOf("data"), 1);
  }
  return uninstallTermyte(selected);
}

export function uninstallTermyte(selected: Removal[], env: NodeJS.ProcessEnv = process.env): number {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (selected.includes("claude-code")) removeTermyteHookEntries(join(home, ".claude", "settings.json"));
  if (selected.includes("codex")) removeTermyteHookEntries(join(home, ".codex", "hooks.json"));
  if (selected.includes("opencode")) uninstallOpenCode(home);
  if (selected.includes("data")) {
    const config = loadUserConfig(env);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${config.dbPath}${suffix}`)) rmSync(`${config.dbPath}${suffix}`, { force: true });
    }
    rmSync(termyteHome(env), { recursive: true, force: true });
  }
  process.stdout.write("Termyte uninstall complete.\n");
  return 0;
}
