import { checkbox, confirm } from "@inquirer/prompts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, termyteHome } from "./config.js";

type Removal = "claude-code" | "codex" | "data";

export async function uninstallCommand(): Promise<number> {
  const selected = await checkbox<Removal>({
    message: "Select what Termyte should remove",
    choices: [
      { name: "Claude Code integration", value: "claude-code", checked: true },
      { name: "Codex integration", value: "codex", checked: true },
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
  if (selected.includes("claude-code")) removeHookEntries(join(home, ".claude", "settings.json"));
  if (selected.includes("codex")) removeHookEntries(join(home, ".codex", "hooks.json"));
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

function removeHookEntries(path: string): void {
  if (!existsSync(path)) return;
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return; }
  if (!parsed.hooks || typeof parsed.hooks !== "object") return;
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    parsed.hooks[event] = groups.filter((group: any) =>
      !Array.isArray(group?.hooks) || !group.hooks.some((hook: any) => typeof hook?.command === "string" && hook.command.includes("termyte-hook")),
    );
    if (parsed.hooks[event].length === 0) delete parsed.hooks[event];
  }
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}
