import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGIN_REF = "./plugins/termyte.js";

type OpenCodeConfig = { plugin?: unknown; [key: string]: unknown };

export function openCodeConfigDir(homeDir = homedir()): string {
  return process.env.OPENCODE_CONFIG_DIR ?? join(homeDir, ".config", "opencode");
}

export function openCodePluginSource(hookCommand = "termyte-hook"): string {
  return `import { spawn } from "node:child_process";
const send=(event,payload)=>{const child=spawn(${JSON.stringify(hookCommand)},["opencode"],{stdio:["pipe","ignore","ignore"],windowsHide:true});child.on("error",()=>{});child.stdin.end(JSON.stringify({event,...payload}));};
const initialized=new Set();
const init=(session_id,cwd)=>{if(!initialized.has(session_id)){initialized.add(session_id);send("session_start",{session_id,cwd});}};
export default async ({directory})=>({
"tool.execute.after":async(input,output)=>{init(input.sessionID,directory);send("tool_completed",{session_id:input.sessionID,event_id:input.callID,cwd:directory,tool_name:input.tool,tool_input:output.args??{},tool_output:output.output??""});},
"chat.message":async(_input,output)=>{const m=output.message;if(!m?.sessionID)return;init(m.sessionID,directory);const text=(output.parts??[]).filter(p=>p.type==="text"&&typeof p.text==="string").map(p=>p.text).join("\\n");if(!text)return;if(m.role==="user")send("user_prompt",{session_id:m.sessionID,event_id:m.id,cwd:directory,prompt:text});else if(m.role==="assistant")send("assistant_message",{session_id:m.sessionID,event_id:m.id,cwd:directory,message:text});},
"experimental.session.compacting":async(input)=>{init(input.sessionID,directory);send("compaction",{session_id:input.sessionID,cwd:directory});},
event:async({event})=>{const id=event?.properties?.sessionID??event?.properties?.info?.id;if(!id)return;if(event.type==="session.idle")send("session_idle",{session_id:id,cwd:directory});else if(event.type==="session.deleted")initialized.delete(id);}
});
`;
}

export function installOpenCode(opts: { homeDir?: string; hookCommand?: string } = {}): number {
  const dir = openCodeConfigDir(opts.homeDir);
  const pluginDir = join(dir, "plugins");
  const configPath = join(dir, "opencode.json");
  try {
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "termyte.js"), openCodePluginSource(opts.hookCommand), "utf8");
    const config: OpenCodeConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : { $schema: "https://opencode.ai/config.json" };
    const plugins = Array.isArray(config.plugin) ? config.plugin : config.plugin === undefined ? [] : [config.plugin];
    config.plugin = [...new Set([...plugins, PLUGIN_REF])];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return 0;
  } catch { return 1; }
}

export function uninstallOpenCode(homeDir?: string): boolean {
  const dir = openCodeConfigDir(homeDir);
  const configPath = join(dir, "opencode.json");
  let changed = false;
  if (existsSync(join(dir, "plugins", "termyte.js"))) { rmSync(join(dir, "plugins", "termyte.js")); changed = true; }
  if (existsSync(configPath)) {
    try {
      const config: OpenCodeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      const plugins = (Array.isArray(config.plugin) ? config.plugin : [config.plugin]).filter((value) => value && value !== PLUGIN_REF);
      config.plugin = plugins;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      changed = true;
    } catch { /* preserve unreadable user config */ }
  }
  return changed;
}
