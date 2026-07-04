/**
 * `termyte <command> [args]`
 *
 * Subcommands:
 *   search    <query>  [--repo r] [--limit n] [--json] [--files f1,f2] [--type t]
 *   context            [--repo r] [--query q] [--limit n] [--files f1,f2] [--type t]
 *   memories           [--repo r] [--limit n] [--type t]
 *   memory    <id>     [--json]
 *   explain   <id>     [--json]
 *   trace     <id>     [--json]
 *   session   <id>     [--json]
 *   sessions           [--limit n]
 *   install   <platform> [--target user|project]
 *   eval               [--suite retrieval|durability|lifecycle|all] [--json]
 *   bench run          --dataset path [--track retrieval|pipeline] [--adapter fts|termyte] [--output dir]
 *   viewer             [--host 127.0.0.1] [--port 7331]
 *   mcp                (stdio server for MCP-capable IDEs)
 *   help
 */
import { searchCommand } from "./search.js";
import { contextCommand } from "./context.js";
import { explainCommand } from "./explain.js";
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { installFor, listSupportedPlatforms } from "../integrations/installers/index.js";
import { runMcpServer } from "../mcp/server.js";
import { isMemoryEligible, ALL_MEMORY_STATES } from "../retrieval/eligibility.js";

const USAGE = `termyte - memory layer for coding agents

Usage:
  termyte search    <query>  [--repo r] [--limit n] [--json] [--files f1,f2] [--type trace|observation|memory|summary|episode|all] [--all-states]
  termyte context            [--repo r] [--query q] [--limit n] [--files f1,f2] [--type trace|observation|memory|summary|episode|all]
  termyte memories           [--repo r] [--limit n] [--type t] [--all-states]
  termyte memory    <id>     [--json]
  termyte explain   <id>     [--json]
  termyte trace     <id>     [--json]
  termyte session   <id>     [--json]
  termyte sessions           [--limit n]
  termyte install   <platform> [--target user|project]
  termyte eval      [--suite retrieval|durability|lifecycle|all] [--json]
  termyte bench run [--dataset <path>] [--suite custom|longmemeval|scale] [--size n] [--track retrieval|pipeline] [--adapter grep,fts,termyte] [--embedding-model bge-small|nomic-embed] [--output dir] [--seed n]
  termyte viewer    [--host 127.0.0.1] [--port 7331]
  termyte synth     [options]              (generate observations from captured traces)
  termyte stats                                 (local stats — no network)
  termyte health                                (queue health and dead-letter diagnostics)
  termyte dead-letters                          (list dead-lettered jobs)
  termyte retry      <jobId>                    (retry a dead-lettered job)
  termyte dismiss   <jobId>                    (remove a dead-lettered job)
  termyte mcp                (stdio MCP server)
  termyte help

Supported install platforms:
  ${listSupportedPlatforms().join(", ")}

termyte synth options: --adapter claude-code|codex|opencode|gemini-cli
                       --dry-run --max-budget-usd N --batch-size N
                       --session <id> --repo <repo_id> --json
`;

function parseArgs(argv: string[]): { positional: string[]; opts: Record<string, string | boolean> } {
  const positional: string[] = [];
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") { opts["json"] = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { opts[key] = next; i++; }
      else opts[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const { positional, opts } = parseArgs(rest);

  try {
    switch (command) {
      case "search": {
        const query = positional.join(" ").trim();
        if (!query) { process.stderr.write("usage: termyte search <query>\n"); process.exit(2); }
        await searchCommand(query, {
          repo_id: typeof opts["repo"] === "string" ? opts["repo"] : undefined,
          limit: typeof opts["limit"] === "string" ? parseInt(opts["limit"], 10) : undefined,
          json: opts["json"] === true,
          currentFiles: typeof opts["files"] === "string" ? (opts["files"] as string).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
          type: typeof opts["type"] === "string" ? opts["type"] : undefined,
          allStates: opts["all-states"] === true,
        });
        break;
      }
      case "context": {
        await contextCommand({
          repo_id: typeof opts["repo"] === "string" ? opts["repo"] : undefined,
          query: typeof opts["query"] === "string" ? opts["query"] : undefined,
          limit: typeof opts["limit"] === "string" ? parseInt(opts["limit"], 10) : undefined,
          currentFiles: typeof opts["files"] === "string" ? (opts["files"] as string).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
          type: typeof opts["type"] === "string" ? opts["type"] : undefined,
        });
        break;
      }
      case "memories": {
        await memoriesCommand({
          repo_id: typeof opts["repo"] === "string" ? opts["repo"] : undefined,
          limit: typeof opts["limit"] === "string" ? parseInt(opts["limit"], 10) : undefined,
          type: typeof opts["type"] === "string" ? opts["type"] : undefined,
          includeAllStates: opts["all-states"] === true,
        });
        break;
      }
      case "memory": {
        const idStr = positional[0];
        if (!idStr) { process.stderr.write("usage: termyte memory <id>\n"); process.exit(2); }
        const id = parseInt(idStr, 10);
        if (isNaN(id)) { process.stderr.write("termyte: invalid id\n"); process.exit(2); }
        await showMemoryCommand(id, opts["json"] === true);
        break;
      }
      case "explain": {
        const id = positional[0];
        if (!id) { process.stderr.write("usage: termyte explain <id>\n"); process.exit(2); }
        await explainCommand({ id, json: opts["json"] === true });
        break;
      }
      case "trace": {
        const idStr = positional[0];
        if (!idStr) { process.stderr.write("usage: termyte trace <id>\n"); process.exit(2); }
        const id = parseInt(idStr, 10);
        if (isNaN(id)) { process.stderr.write("termyte: invalid id\n"); process.exit(2); }
        await showTraceCommand(id, opts["json"] === true);
        break;
      }
      case "session": {
        const sid = positional[0];
        if (!sid) { process.stderr.write("usage: termyte session <session_id>\n"); process.exit(2); }
        await showSessionCommand(sid, opts["json"] === true);
        break;
      }
      case "sessions": {
        const limit = typeof opts["limit"] === "string" ? parseInt(opts["limit"], 10) : 20;
        await listSessionsCommand(limit);
        break;
      }
      case "install": {
        const platform = positional[0];
        if (!platform) {
          process.stdout.write(`Supported platforms: ${listSupportedPlatforms().join(", ")}\n`);
          process.exit(0);
        }
        const target = typeof opts["target"] === "string"
          ? (opts["target"] as "user" | "project")
          : "user";
        const code = installFor(platform, { target });
        process.exit(code);
      }
      case "eval": {
        const mod = await import("./eval.js");
        await mod.evalCommand({
          suite: typeof opts["suite"] === "string" ? opts["suite"] : undefined,
          corpus: typeof opts["corpus"] === "string" ? opts["corpus"] : undefined,
          json: opts["json"] === true,
        });
        process.exit(0);
      }
      case "bench": {
        if (positional[0] !== "run") throw new Error("usage: termyte bench run --dataset <path>");
        const mod = await import("./bench.js");
        await mod.benchCommand(opts);
        break;
      }
      case "viewer": {
        const mod = await import("./viewer.js");
        await mod.viewerCommand({
          host: typeof opts["host"] === "string" ? opts["host"] : undefined,
          port: typeof opts["port"] === "string" ? parseInt(opts["port"], 10) : undefined,
        });
        break;
      }
      case "mcp": {
        await runMcpServer();
        process.exit(0);
      }
      case "synth": {
        // Forward to the synth CLI. Re-exec via dynamic import so we
        // don't have to import the (large) LocalEmbeddingsProvider
        // graph when the user runs other subcommands.
        const mod = await import("./synth.js");
        await mod.runMain();
        process.exit(0);
      }
      case "stats": {
        const mod = await import("./stats.js");
        await mod.runMain();
        process.exit(0);
      }
      case "health": {
        const config = loadConfig();
        const s = new Store(config.dbPath);
        try {
          const health = s.getHealthDiagnostics();
          process.stdout.write(`Termyte Health\n`);
          process.stdout.write(`  queue:  pending=${health.queue.pending} leased=${health.queue.leased} succeeded=${health.queue.succeeded} failed=${health.queue.failed} dead=${health.queue.dead}\n`);
          if (health.oldestPendingAgeMs != null) {
            process.stdout.write(`  oldest pending age: ${(health.oldestPendingAgeMs / 1000).toFixed(1)}s\n`);
          }
          if (health.deadJobs > 0) {
            const dead = s.getDeadJobs(10);
            process.stdout.write(`  dead letters (${health.deadJobs}):\n`);
            for (const j of dead) {
              process.stdout.write(`    ${j.id} [${j.kind}] subject=${j.subject_type}:${j.subject_id} attempts=${j.attempt_count} error=${(j.last_error ?? "").slice(0, 120)}\n`);
            }
            process.stdout.write(`  Use 'termyte retry <jobId>' or 'termyte dismiss <jobId>'\n`);
          } else {
            process.stdout.write(`  dead letters: none\n`);
          }
        } finally { s.close(); }
        break;
      }
      case "dead-letters": {
        const config = loadConfig();
        const s = new Store(config.dbPath);
        try {
          const dead = s.getDeadJobs(100);
          if (dead.length === 0) { process.stdout.write("(no dead-lettered jobs)\n"); break; }
          for (const j of dead) {
            process.stdout.write(`${j.id}  [${j.kind}]  ${j.subject_type}:${j.subject_id}  attempts=${j.attempt_count}\n`);
            if (j.last_error) process.stdout.write(`  error: ${j.last_error.slice(0, 200)}\n`);
          }
        } finally { s.close(); }
        break;
      }
      case "retry": {
        const jobId = positional[0];
        if (!jobId) { process.stderr.write("usage: termyte retry <jobId>\n"); process.exit(2); }
        const config = loadConfig();
        const s = new Store(config.dbPath);
        try {
          if (s.retryDeadJob(jobId)) {
            process.stdout.write(`termyte: job ${jobId} retried (reset to pending)\n`);
          } else {
            process.stderr.write(`termyte: job ${jobId} not found or not in dead state\n`);
            process.exit(1);
          }
        } finally { s.close(); }
        break;
      }
      case "dismiss": {
        const jobId = positional[0];
        if (!jobId) { process.stderr.write("usage: termyte dismiss <jobId>\n"); process.exit(2); }
        const config = loadConfig();
        const s = new Store(config.dbPath);
        try {
          if (s.dismissDeadJob(jobId)) {
            process.stdout.write(`termyte: job ${jobId} dismissed (removed)\n`);
          } else {
            process.stderr.write(`termyte: job ${jobId} not found or not in dead state\n`);
            process.exit(1);
          }
        } finally { s.close(); }
        break;
      }
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`termyte: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function memoriesCommand(opts: { repo_id?: string; limit?: number; type?: string; includeAllStates?: boolean }): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const limit = opts.limit ?? 50;
    const allMemories = store.getRecentMemories(limit, opts.repo_id);
    const memories = opts.includeAllStates
      ? allMemories
      : allMemories.filter((m) => isMemoryEligible(m));
    const filtered = opts.type ? memories.filter(m => m.type === opts.type) : memories;
    if (filtered.length === 0) { process.stdout.write("(no memories)\n"); return; }
    for (const m of filtered) {
      process.stdout.write(`#${m.id} [${m.type}] ${m.title}\n`);
      if (m.description) {
        process.stdout.write(`  ${m.description.split("\n")[0]!.slice(0, 120)}\n`);
      }
      process.stdout.write(`  repo: ${m.repo_id} | session: ${m.session_id}\n`);
      if (m.source_observation_ids.length > 0) {
        process.stdout.write(`  observations: ${m.source_observation_ids.join(", ")}\n`);
      }
      process.stdout.write("\n");
    }
  } finally { store.close(); }
}

async function showMemoryCommand(id: number, json: boolean): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const memory = store.getMemory(id);
    if (!memory) { process.stderr.write(`memory ${id} not found\n`); process.exit(1); }
    if (json) {
      process.stdout.write(JSON.stringify(memory, memoryReplacer, 2) + "\n");
    } else {
      process.stdout.write(`=== Memory #${memory.id} ===\n`);
      process.stdout.write(`Type:       ${memory.type}\n`);
      process.stdout.write(`Title:      ${memory.title}\n`);
      process.stdout.write(`Repo:       ${memory.repo_id}\n`);
      process.stdout.write(`Workspace:  ${memory.workspace_root}\n`);
      process.stdout.write(`Session:    ${memory.session_id}\n`);
      process.stdout.write(`Created:    ${new Date(memory.created_at).toISOString()}\n`);
      if (memory.description) process.stdout.write(`\n${memory.description}\n`);
      if (memory.files_read.length > 0) process.stdout.write(`\nFiles read:\n${memory.files_read.map(f => `  ${f}`).join("\n")}\n`);
      if (memory.files_modified.length > 0) process.stdout.write(`\nFiles modified:\n${memory.files_modified.map(f => `  ${f}`).join("\n")}\n`);
      if (memory.source_observation_ids.length > 0) process.stdout.write(`\nSource observations: ${memory.source_observation_ids.join(", ")}\n`);
      if (memory.source_trace_ids.length > 0) process.stdout.write(`Source traces: ${memory.source_trace_ids.join(", ")}\n`);
    }
  } finally { store.close(); }
}

async function showTraceCommand(id: number, json: boolean): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const trace = store.getTrace(id);
    if (!trace) { process.stderr.write(`trace ${id} not found\n`); process.exit(1); }
    if (json) {
      process.stdout.write(JSON.stringify(trace, traceReplacer, 2) + "\n");
    } else {
      process.stdout.write(`=== Trace #${trace.id} ===\n`);
      process.stdout.write(`Event:      ${trace.event_type}\n`);
      process.stdout.write(`Tool:       ${trace.tool_name ?? "(none)"}\n`);
      process.stdout.write(`Session:    ${trace.session_id}\n`);
      process.stdout.write(`Timestamp:  ${new Date(trace.timestamp).toISOString()}\n`);
      process.stdout.write(`Processed:  ${trace.processed_at ? new Date(trace.processed_at).toISOString() : "not yet"}\n`);
      if (trace.user_prompt) process.stdout.write(`\nUser prompt:\n${trace.user_prompt}\n`);
      if (trace.tool_input != null) process.stdout.write(`\nTool input:\n${JSON.stringify(trace.tool_input, null, 2)}\n`);
      if (trace.tool_output != null) process.stdout.write(`\nTool output:\n${JSON.stringify(trace.tool_output, null, 2).slice(0, 2000)}\n`);
      if (trace.files_read && trace.files_read.length > 0) process.stdout.write(`\nFiles read: ${trace.files_read.join(", ")}\n`);
      if (trace.files_modified && trace.files_modified.length > 0) process.stdout.write(`\nFiles modified: ${trace.files_modified.join(", ")}\n`);
    }
  } finally { store.close(); }
}

async function showSessionCommand(session_id: string, json: boolean): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const session = store.getSession(session_id);
    if (!session) { process.stderr.write(`session ${session_id} not found\n`); process.exit(1); }
    if (json) {
      process.stdout.write(JSON.stringify(session, null, 2) + "\n");
    } else {
      process.stdout.write(`=== Session ===\n`);
      process.stdout.write(`ID:         ${session.session_id}\n`);
      process.stdout.write(`Project:    ${session.project}\n`);
      process.stdout.write(`Repo:       ${session.repo_id ?? "(unknown)"}\n`);
      process.stdout.write(`Workspace:  ${session.workspace_root ?? "(unknown)"}\n`);
      process.stdout.write(`Started:    ${new Date(session.started_at).toISOString()}\n`);
      process.stdout.write(`Ended:      ${session.ended_at ? new Date(session.ended_at).toISOString() : "(active)"}\n`);
      const traces = store.getTracesForSession(session_id, 20);
      process.stdout.write(`\nTraces (${traces.length}):\n`);
      for (const t of traces) {
        process.stdout.write(`  #${t.id} ${t.event_type} ${t.tool_name ?? ""}\n`);
      }
      const summary = store.getSummary(session_id);
      if (summary) {
        process.stdout.write(`\nSummary:\n`);
        if (summary.summary) process.stdout.write(`${summary.summary}\n`);
        if (summary.key_changes && summary.key_changes.length > 0) {
          process.stdout.write(`\nKey changes:\n`);
          for (const c of summary.key_changes) process.stdout.write(`  - ${c}\n`);
        }
        if (summary.key_learnings && summary.key_learnings.length > 0) {
          process.stdout.write(`\nKey learnings:\n`);
          for (const l of summary.key_learnings) process.stdout.write(`  - ${l}\n`);
        }
      }
    }
  } finally { store.close(); }
}

async function listSessionsCommand(limit: number): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const db = store.getDB();
    const rows = db.prepare(
      `SELECT session_id, project, repo_id, started_at, ended_at FROM sessions ORDER BY started_at DESC LIMIT ?`
    ).all(limit) as any[];
    if (rows.length === 0) { process.stdout.write("(no sessions)\n"); return; }
    for (const row of rows) {
      const status = row.ended_at ? "ended" : "active";
      process.stdout.write(`${row.session_id}  ${row.project}  ${row.repo_id ?? "?"}  ${status}  ${new Date(row.started_at).toISOString()}\n`);
    }
  } finally { store.close(); }
}

function memoryReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Float32Array) return Array.from(value);
  return value;
}

function traceReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

main();
