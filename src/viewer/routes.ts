import type { IncomingMessage, ServerResponse } from "node:http";
import { JobQueue } from "../pipeline/job-queue.js";
import type { DB } from "../storage/connection.js";

export interface ViewerRouteContext {
  db: DB;
}

export async function handleViewerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: ViewerRouteContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (url.pathname === "/") {
    sendHtml(res, renderHome());
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, health(context.db));
    return;
  }

  if (url.pathname === "/api/jobs/summary") {
    sendJson(res, 200, new JobQueue(context.db).getQueueStats());
    return;
  }

  if (url.pathname === "/api/dead-letter") {
    sendJson(res, 200, { jobs: deadLetterJobs(context.db) });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function health(db: DB): Record<string, unknown> {
  db.prepare("SELECT 1").get();

  return {
    ok: true,
    database: "ok",
    sqliteVecAvailable: hasTable(db, "memories_vec") || hasTableLike(db, "document_vec_%"),
    ftsAvailable: hasTable(db, "memories_fts") || hasTable(db, "documents_fts"),
    timestamp: Date.now(),
  };
}

function deadLetterJobs(db: DB): unknown[] {
  return db.prepare(`
    SELECT
      id,
      kind,
      subject_type AS subjectType,
      subject_id AS subjectId,
      state,
      attempt_count AS attemptCount,
      max_attempts AS maxAttempts,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM jobs
    WHERE state IN ('failed', 'dead')
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();
}

function hasTable(db: DB, name: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?
  `).get(name);
  return Boolean(row);
}

function hasTableLike(db: DB, pattern: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name LIKE ?
  `).get(pattern);
  return Boolean(row);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function renderHome(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Termyte Viewer</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #0b0f14; color: #e6edf3; }
    a { color: #7dd3fc; }
    code { background: #111827; padding: .15rem .35rem; border-radius: .25rem; }
  </style>
</head>
<body>
  <h1>Termyte Viewer</h1>
  <p>Local diagnostics endpoints:</p>
  <ul>
    <li><a href="/api/health"><code>/api/health</code></a></li>
    <li><a href="/api/jobs/summary"><code>/api/jobs/summary</code></a></li>
    <li><a href="/api/dead-letter"><code>/api/dead-letter</code></a></li>
  </ul>
</body>
</html>`;
}
