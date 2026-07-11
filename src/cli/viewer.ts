import { loadConfig } from "./config.js";
import { startViewerServer } from "../viewer/server.js";
import { spawn } from "node:child_process";

export interface ViewerCommandOptions {
  host?: string;
  port?: number;
  open?: boolean;
}

export async function viewerCommand(options: ViewerCommandOptions = {}): Promise<void> {
  const config = loadConfig();
  const running = await startViewerServer({
    dbPath: config.dbPath,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7331,
  });

  process.stdout.write(`Termyte viewer running at ${running.url}\n`);
  if (options.open !== false) openBrowser(running.url);
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
