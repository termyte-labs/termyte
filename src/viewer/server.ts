import { createServer, type Server } from "node:http";
import type { DB } from "../storage/connection.js";
import { Store } from "../storage/store.js";
import { handleViewerRequest } from "./routes.js";

export interface ViewerServerOptions {
  dbPath?: string;
  db?: DB;
  host?: string;
  port?: number;
}

export interface RunningViewerServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startViewerServer(
  options: ViewerServerOptions = {},
): Promise<RunningViewerServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7331;
  const ownedStore = options.db ? null : new Store(options.dbPath ?? "./termyte.db");
  const db = options.db ?? ownedStore!.getDB();

  const server = createServer((req, res) => {
    void handleViewerRequest(req, res, { db }).catch((error) => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      if (ownedStore) ownedStore.close();
    },
  };
}
