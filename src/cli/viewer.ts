import { loadConfig } from "./config.js";
import { startViewerServer } from "../viewer/server.js";

export interface ViewerCommandOptions {
  host?: string;
  port?: number;
}

export async function viewerCommand(options: ViewerCommandOptions = {}): Promise<void> {
  const config = loadConfig();
  const running = await startViewerServer({
    dbPath: config.dbPath,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7331,
  });

  process.stdout.write(`Termyte viewer running at ${running.url}\n`);
}
