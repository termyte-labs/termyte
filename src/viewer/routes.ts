import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Store } from "../storage/store.js";

export interface ViewerRouteContext {
  store: Store;
  csrfToken: string;
  assetDir: string;
}

export async function handleViewerRequest(req: IncomingMessage, res: ServerResponse, context: ViewerRouteContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url, context);
    return;
  }
  serveAsset(res, url.pathname, context.assetDir, context.csrfToken);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, context: ViewerRouteContext): Promise<void> {
  if (req.method !== "GET") {
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return error(res, 403, "invalid_origin", "Cross-origin mutations are not allowed");
    if (req.headers["x-termyte-csrf"] !== context.csrfToken) return error(res, 403, "invalid_csrf", "Missing or invalid Viewer token");
  }

  const store = context.store;
  if (req.method === "GET" && url.pathname === "/api/overview") {
    const db = store.getDB();
    return data(res, {
      sessions: count(db, "sessions"), episodes: count(db, "episodes"),
      traces: count(db, "traces"), memories: count(db, "memories"),
      packets: count(db, "context_packets"), health: store.getHealthDiagnostics(),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/sessions") return data(res, store.getRecentSessions(readLimit(url)));
  const session = match(url.pathname, /^\/api\/sessions\/([^/]+)$/);
  if (req.method === "GET" && session) {
    const row = store.getSession(decodeURIComponent(session));
    if (!row) return error(res, 404, "not_found", "Session not found");
    return data(res, { session: row, episodes: store.getEpisodes({ sessionId: row.session_id }), packets: store.getContextPackets({ sessionId: row.session_id }) });
  }
  if (req.method === "GET" && url.pathname === "/api/episodes") return data(res, store.getEpisodes({ limit: readLimit(url) }));
  const episode = match(url.pathname, /^\/api\/episodes\/([^/]+)$/);
  if (req.method === "GET" && episode) {
    const row = store.getEpisode(episode);
    if (!row) return error(res, 404, "not_found", "Episode not found");
    return data(res, { episode: row, traces: store.getEpisodeTraces(row.id), evidence: store.getEvidenceForEpisode(row.id), outcomes: store.getEpisodeOutcomes(row.id) });
  }
  const outcome = match(url.pathname, /^\/api\/episodes\/([^/]+)\/outcomes$/);
  if (req.method === "POST" && outcome) {
    const body = await readJson(req);
    if (!["succeeded", "failed", "partial", "abandoned", "unknown"].includes(String(body.status))) return error(res, 400, "invalid_status", "Invalid episode outcome");
    return data(res, store.recordEpisodeOutcome({ episodeId: outcome, status: body.status as any, source: "viewer", notes: typeof body.notes === "string" ? body.notes : null }));
  }
  const packet = match(url.pathname, /^\/api\/context-packets\/([^/]+)$/);
  if (req.method === "GET" && packet) {
    const row = store.getContextPacket(packet);
    if (!row) return error(res, 404, "not_found", "Context packet not found");
    return data(res, { packet: row, candidates: store.getContextCandidates(row.id) });
  }
  if (req.method === "GET" && url.pathname === "/api/memories") return data(res, store.getRecentMemories(readLimit(url)));
  const memory = match(url.pathname, /^\/api\/memories\/(\d+)$/);
  if (req.method === "GET" && memory) {
    const row = store.getMemory(Number(memory));
    if (!row) return error(res, 404, "not_found", "Memory not found");
    return data(res, { memory: row, feedback: store.getMemoryFeedbackForMemory(row.id), edges: store.getMemoryEdges(row.id) });
  }
  const feedback = match(url.pathname, /^\/api\/memories\/(\d+)\/feedback$/);
  if (req.method === "POST" && feedback) {
    const body = await readJson(req);
    const eventMap: Record<string, "used" | "downranked" | "ignored" | "corrected"> = { helpful: "used", harmful: "downranked", irrelevant: "ignored", corrected: "corrected" };
    const event = eventMap[String(body.event)];
    if (!event) return error(res, 400, "invalid_feedback", "Invalid feedback event");
    const result = store.recordMemoryFeedback({ id: `memory:${feedback}`, event, source: "viewer", correctionText: typeof body.correctionText === "string" ? body.correctionText : undefined });
    if (!result.recorded) return error(res, 404, "not_found", result.reason ?? "Memory not found");
    return data(res, result);
  }
  if (req.method === "GET" && url.pathname === "/api/diagnostics") {
    const problemJobs = store.getDB().prepare(`
      SELECT id, kind, subject_type, subject_id, state, attempt_count, last_error, updated_at
      FROM jobs WHERE state IN ('failed', 'dead') ORDER BY updated_at DESC LIMIT 100
    `).all();
    return data(res, { health: store.getHealthDiagnostics(), problemJobs, audit: store.getAuditLog({ limit: 100 }) });
  }
  const retry = match(url.pathname, /^\/api\/jobs\/([^/]+)\/retry$/);
  if (req.method === "POST" && retry) return store.retryDeadJob(retry) ? data(res, { retried: true }) : error(res, 404, "not_found", "Dead job not found");
  return error(res, 404, "not_found", "Route not found");
}

function serveAsset(res: ServerResponse, pathname: string, assetDir: string, csrfToken: string): void {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  let path = join(assetDir, safe);
  if (!existsSync(path) && !extname(safe)) path = join(assetDir, "index.html");
  if (!existsSync(path)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><html><head><meta name="termyte-csrf" content="${csrfToken}"><title>Termyte Viewer</title></head><body><h1>Termyte Viewer</h1><p>Viewer assets have not been built.</p></body></html>`);
    return;
  }
  let body: Buffer | string = readFileSync(path);
  if (path.endsWith("index.html")) body = body.toString("utf8").replace("</head>", `<meta name="termyte-csrf" content="${csrfToken}"></head>`);
  res.writeHead(200, { "content-type": contentType(path), "cache-control": path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" });
  res.end(body);
}

function data(res: ServerResponse, payload: unknown): void { sendJson(res, 200, { data: payload }); }
function error(res: ServerResponse, status: number, code: string, message: string): void { sendJson(res, status, { error: { code, message } }); }
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}
function match(value: string, pattern: RegExp): string | null { return value.match(pattern)?.[1] ?? null; }
function readLimit(url: URL): number { const value = Number(url.searchParams.get("limit") ?? 100); return Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 100; }
function count(db: ReturnType<Store["getDB"]>, table: string): number { return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count; }
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}
function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}
