import type { DB } from "./connection.js";

/**
 * The Termyte schema. Five tables.
 *
 *   sessions(id, session_id, project, repo_id, workspace_root,
 *            started_at, ended_at)
 *   traces(id, session_id, timestamp, event_type, tool_name, tool_input,
 *          tool_output, files_read, files_modified, user_prompt,
 *          final_response, processed_at)
 *   observations(id, session_id, repo_id, workspace_root, type,
 *                title, description, files_read, files_modified,
 *                commands_executed, source_trace_ids, created_at,
 *                processed_at, embedding)
 *   memories(id, session_id, repo_id, workspace_root, type, title,
 *            description, files_read, files_modified,
 *            source_observation_ids, source_trace_ids, created_at,
 *            embedding, applicability_json)
 *   summaries(id, session_id, repo_id, workspace_root, summary,
 *             key_changes, key_learnings, created_at)
 *
 * JSON columns are stored as TEXT. Embeddings as BLOBs (Float32).
 *
 * FTS5 mirrors: observations_fts, memories_fts (content-sync triggers).
 * vec0 virtual table: memories_vec (via sqlite-vec extension).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  repo_id TEXT,
  workspace_root TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN
    ('session_init', 'user_prompt', 'tool_use', 'assistant_message', 'compaction', 'session_end')),
  tool_name TEXT,
  tool_input TEXT,
  tool_output TEXT,
  files_read TEXT,
  files_modified TEXT,
  user_prompt TEXT,
  final_response TEXT,
  redaction_json TEXT NOT NULL DEFAULT '{}',
  platform_event_id TEXT,
  content_hash TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  ingested_at INTEGER,
  processed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_traces_unprocessed
  ON traces(processed_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  trace_id INTEGER NOT NULL UNIQUE REFERENCES traces(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id, ordinal);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  completion_trace_id INTEGER NOT NULL UNIQUE REFERENCES traces(id) ON DELETE CASCADE,
  platform_tool_id TEXT,
  name TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'unknown')),
  exit_code INTEGER,
  completed_at INTEGER NOT NULL,
  UNIQUE(session_id, platform_tool_id)
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, completed_at);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  trace_id INTEGER NOT NULL UNIQUE REFERENCES traces(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  cwd TEXT,
  exit_code INTEGER,
  completed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_changes (
  id TEXT PRIMARY KEY,
  trace_id INTEGER NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('read', 'modify')),
  UNIQUE(trace_id, path, operation)
);
CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(path, trace_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'paused', 'cancelled')),
  current_phase TEXT,
  current_step_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_repo_status ON tasks(repo_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_requirements (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'satisfied', 'superseded', 'rejected')),
  confirmation_kind TEXT CHECK(confirmation_kind IN ('user', 'deterministic-verifier')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'verified', 'failed', 'blocked')),
  verification_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id, position)
);

CREATE TABLE IF NOT EXISTS task_decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed', 'active', 'superseded', 'rejected')),
  confirmed_by TEXT,
  supersedes_decision_id TEXT REFERENCES task_decisions(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_failures (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  command_id TEXT REFERENCES commands(id),
  exit_code INTEGER,
  user_note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('command', 'test', 'git', 'file', 'user')),
  trace_id INTEGER REFERENCES traces(id),
  command_id TEXT REFERENCES commands(id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  verdict TEXT NOT NULL CHECK(verdict IN ('passed', 'failed', 'inconclusive')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_step_evidence (
  step_id TEXT NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES verification_evidence(id) ON DELETE CASCADE,
  PRIMARY KEY(step_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS task_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'verifier', 'agent')),
  reason TEXT,
  task_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_transitions_task ON task_transitions(task_id, created_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(session_id),
  platform TEXT NOT NULL CHECK(platform IN ('claude-code', 'codex', 'opencode', 'raw')),
  branch TEXT,
  commit_hash TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_platform TEXT NOT NULL,
  target_platform TEXT NOT NULL,
  checkpoint_id TEXT REFERENCES checkpoints(id),
  task_version INTEGER NOT NULL,
  packet_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL DEFAULT 'once',
  state TEXT NOT NULL CHECK(state IN
    ('pending', 'leased', 'succeeded', 'failed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  lease_owner TEXT,
  lease_until INTEGER,
  next_run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, subject_type, subject_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(state, next_run_at, kind);
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(state, lease_until);
CREATE INDEX IF NOT EXISTS jobs_subject_idx ON jobs(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN
    ('bugfix', 'convention', 'warning', 'procedure', 'fact')),
  title TEXT NOT NULL,
  description TEXT,
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  commands_executed TEXT NOT NULL DEFAULT '[]',
  source_trace_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  embedding BLOB,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_repo ON observations(repo_id);
CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_unprocessed
  ON observations(processed_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN
    ('bugfix', 'convention', 'warning', 'procedure', 'fact')),
  title TEXT NOT NULL,
  description TEXT,
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  source_observation_ids TEXT NOT NULL DEFAULT '[]',
  source_trace_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  embedding BLOB,
  applicability_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN
    ('active', 'stale', 'superseded', 'conflicted', 'deleted')),
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  last_reinforced_at INTEGER,
  decayed_score REAL NOT NULL DEFAULT 0.5,
  content_hash TEXT,
  canonical_key TEXT,
  superseded_by INTEGER REFERENCES memories(id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repo_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
CREATE INDEX IF NOT EXISTS idx_memories_canonical_key ON memories(canonical_key);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  summary TEXT,
  key_changes TEXT NOT NULL DEFAULT '[]',
  key_learnings TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_summaries_repo ON summaries(repo_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON summaries(created_at DESC);

-- FTS5 mirror for observations
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  description,
  content='observations',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, description)
  VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
END;

CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
  INSERT INTO observations_fts(rowid, title, description)
  VALUES (new.id, new.title, new.description);
END;

-- FTS5 mirror for memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  description,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, description)
  VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
END;

CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
  INSERT INTO memories_fts(rowid, title, description)
  VALUES (new.id, new.title, new.description);
END;

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  source_memory_id INTEGER NOT NULL REFERENCES memories(id),
  target_memory_id INTEGER NOT NULL REFERENCES memories(id),
  edge_type TEXT NOT NULL CHECK(edge_type IN
    ('supports', 'contradicts', 'supersedes', 'duplicates', 'derived_from', 'related_to')),
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  UNIQUE(source_memory_id, target_memory_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_type ON memory_edges(edge_type);

CREATE TABLE IF NOT EXISTS memory_feedback (
  id TEXT PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  doc_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN
    ('shown', 'used', 'helpful', 'harmful', 'ignored', 'downranked', 'corrected')),
  weight REAL NOT NULL,
  source TEXT NOT NULL,
  context_injection_id TEXT,
  correction_text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory ON memory_feedback(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_context ON memory_feedback(context_injection_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL CHECK(doc_type IN
    ('trace', 'observation', 'memory', 'summary', 'episode')),
  source_id TEXT NOT NULL,
  session_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  recency_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(doc_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);
CREATE INDEX IF NOT EXISTS idx_documents_recency ON documents(recency_ts DESC);
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  content,
  files,
  tags,
  content='documents',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, content, files, tags)
  VALUES (new.rowid, new.content, new.files_json, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, content, files, tags)
  VALUES('delete', old.rowid, old.content, old.files_json, old.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, content, files, tags)
  VALUES('delete', old.rowid, old.content, old.files_json, old.tags_json);
  INSERT INTO documents_fts(rowid, content, files, tags)
  VALUES (new.rowid, new.content, new.files_json, new.tags_json);
END;

CREATE TABLE IF NOT EXISTS document_embeddings (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_table TEXT NOT NULL,
  embedded_at INTEGER NOT NULL,
  embedding_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_embeddings_model ON document_embeddings(model, dimensions);

CREATE TABLE IF NOT EXISTS trace_observations (
  trace_id INTEGER NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  PRIMARY KEY (trace_id, observation_id)
);
CREATE INDEX IF NOT EXISTS idx_trace_observations_trace ON trace_observations(trace_id);

CREATE TABLE IF NOT EXISTS observation_memories (
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (observation_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_observation_memories_obs ON observation_memories(observation_id);

CREATE TABLE IF NOT EXISTS context_injections (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  repo_id TEXT,
  query TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  memory_ids_json TEXT NOT NULL DEFAULT '[]',
  surface TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_injections_session ON context_injections(session_id);
CREATE INDEX IF NOT EXISTS idx_context_injections_repo ON context_injections(repo_id);
CREATE INDEX IF NOT EXISTS idx_context_injections_created ON context_injections(created_at DESC);

CREATE TABLE IF NOT EXISTS context_injection_items (
  injection_id TEXT NOT NULL REFERENCES context_injections(id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  fts_rank INTEGER,
  vector_rank INTEGER,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  rendered_text TEXT NOT NULL,
  PRIMARY KEY (injection_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_context_injection_items_memory
  ON context_injection_items(memory_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  operation TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_operation ON audit_log(operation);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN
    ('active', 'succeeded', 'failed', 'partial', 'abandoned', 'unknown')),
  base_commit TEXT,
  final_commit TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_repo ON episodes(repo_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_one_active_session
  ON episodes(session_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS episode_traces (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  trace_id INTEGER NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  PRIMARY KEY (episode_id, trace_id)
);
CREATE INDEX IF NOT EXISTS idx_episode_traces_trace ON episode_traces(trace_id);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN
    ('command', 'test', 'build', 'diff', 'file', 'human_feedback', 'agent_statement')),
  content TEXT NOT NULL,
  exit_code INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_episode ON evidence(episode_id, observed_at ASC);
CREATE INDEX IF NOT EXISTS idx_evidence_kind ON evidence(kind);

CREATE TABLE IF NOT EXISTS evidence_traces (
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  trace_id INTEGER NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, trace_id)
);

CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_evidence_evidence ON memory_evidence(evidence_id);

CREATE TABLE IF NOT EXISTS episode_outcomes (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN
    ('succeeded', 'failed', 'partial', 'abandoned', 'unknown')),
  source TEXT NOT NULL CHECK(source IN ('inferred', 'human', 'viewer')),
  notes TEXT,
  context_injection_id TEXT REFERENCES context_injections(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episode_outcomes_episode
  ON episode_outcomes(episode_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_packets (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  repo_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  task TEXT NOT NULL,
  token_budget INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  retrieval_mode TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  rendered_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_packets_session ON context_packets(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_packets_repo ON context_packets(repo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_candidates (
  packet_id TEXT NOT NULL REFERENCES context_packets(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN
    ('current_state', 'repository_knowledge', 'episode', 'summary', 'observation', 'memory', 'procedure', 'evidence')),
  source_id TEXT,
  token_estimate INTEGER NOT NULL,
  selected INTEGER NOT NULL CHECK(selected IN (0, 1)),
  rank INTEGER,
  final_score REAL NOT NULL,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  rejection_reason TEXT,
  rendered_text TEXT NOT NULL,
  PRIMARY KEY (packet_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_context_candidates_selected ON context_candidates(packet_id, selected, rank);

CREATE TABLE IF NOT EXISTS context_effects (
  id TEXT PRIMARY KEY,
  injection_id TEXT NOT NULL REFERENCES context_injections(id) ON DELETE CASCADE,
  packet_id TEXT REFERENCES context_packets(id) ON DELETE SET NULL,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  candidate_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('helped', 'hurt', 'unused', 'unknown')),
  confidence REAL NOT NULL DEFAULT 0.5,
  outcome_status TEXT,
  signals_json TEXT NOT NULL DEFAULT '{}',
  feedback_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(injection_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_context_effects_injection ON context_effects(injection_id);
CREATE INDEX IF NOT EXISTS idx_context_effects_episode ON context_effects(episode_id);
CREATE INDEX IF NOT EXISTS idx_context_effects_memory ON context_effects(memory_id);
CREATE INDEX IF NOT EXISTS idx_context_effects_verdict ON context_effects(verdict);
`;

export function runMigrations(db: DB): void {
  db.exec(SCHEMA);
  ensureJobDedupeKeys(db);
  ensurePipelineColumns(db);
  ensureEventLedgerColumns(db);
  ensureTraceEventKinds(db);
  ensureLifecycleColumns(db);
  ensureProvenanceLinks(db);
  ensureFeedbackColumns(db);
  ensureFeedbackEventKinds(db);
  ensureContextInjectionColumns(db);
  ensureContextCandidateKinds(db);
}

/**
 * Older databases made a job unique forever by kind and subject. That blocked
 * recurring summary and decay work after the first successful run. SQLite
 * cannot alter a table-level UNIQUE constraint, so rebuild the table once and
 * preserve every queued, leased, failed, and completed row.
 */
function ensureJobDedupeKeys(db: DB): void {
  const columns = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "dedupe_key")) return;

  db.transaction(() => {
    db.exec(`
      ALTER TABLE jobs RENAME TO jobs_legacy;
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL DEFAULT 'once',
        state TEXT NOT NULL CHECK(state IN ('pending', 'leased', 'succeeded', 'failed', 'dead')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_owner TEXT,
        lease_until INTEGER,
        next_run_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(kind, subject_type, subject_id, dedupe_key)
      );
      INSERT INTO jobs (
        id, kind, subject_type, subject_id, dedupe_key, state,
        attempt_count, max_attempts, lease_owner, lease_until, next_run_at,
        last_error, created_at, updated_at
      )
      SELECT
        id, kind, subject_type, subject_id, 'once', state,
        attempt_count, max_attempts, lease_owner, lease_until, next_run_at,
        last_error, created_at, updated_at
      FROM jobs_legacy;
      DROP TABLE jobs_legacy;
      CREATE INDEX jobs_ready_idx ON jobs(state, next_run_at, kind);
      CREATE INDEX jobs_lease_idx ON jobs(state, lease_until);
      CREATE INDEX jobs_subject_idx ON jobs(subject_type, subject_id);
    `);
  })();
}

function ensurePipelineColumns(db: DB): void {
  addColumnIfMissing(db, "traces", "pipeline_state", "TEXT DEFAULT 'captured'");
  addColumnIfMissing(db, "traces", "redaction_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "observations", "lifecycle_state", "TEXT DEFAULT 'extracting'");
  addColumnIfMissing(db, "memories", "lifecycle_state", "TEXT DEFAULT 'consolidating'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_traces_pipeline_state ON traces(pipeline_state);
    CREATE INDEX IF NOT EXISTS idx_observations_lifecycle_state ON observations(lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_memories_lifecycle_state ON memories(lifecycle_state);
  `);
}

function ensureLifecycleColumns(db: DB): void {
  addColumnIfMissing(db, "memories", "state", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(db, "memories", "importance", "REAL NOT NULL DEFAULT 0.5");
  addColumnIfMissing(db, "memories", "confidence", "REAL NOT NULL DEFAULT 0.5");
  addColumnIfMissing(db, "memories", "usage_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "memories", "last_accessed_at", "INTEGER");
  addColumnIfMissing(db, "memories", "last_reinforced_at", "INTEGER");
  addColumnIfMissing(db, "memories", "decayed_score", "REAL NOT NULL DEFAULT 0.5");
  addColumnIfMissing(db, "memories", "content_hash", "TEXT");
  addColumnIfMissing(db, "memories", "canonical_key", "TEXT");
  addColumnIfMissing(db, "memories", "superseded_by", "INTEGER REFERENCES memories(id)");
  addColumnIfMissing(db, "memories", "applicability_json", "TEXT NOT NULL DEFAULT '{}'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
    CREATE INDEX IF NOT EXISTS idx_memories_canonical_key ON memories(canonical_key);
  `);
}

function addColumnIfMissing(db: DB, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function ensureFeedbackColumns(db: DB): void {
  addColumnIfMissing(db, "memory_feedback", "correction_text", "TEXT");
}

function ensureContextInjectionColumns(db: DB): void {
  addColumnIfMissing(db, "context_injection_items", "score_breakdown_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing(db, "context_injections", "packet_id", "TEXT REFERENCES context_packets(id) ON DELETE SET NULL");
  addColumnIfMissing(db, "context_injections", "delivery_method", "TEXT NOT NULL DEFAULT 'unknown'");
}

function ensureTraceEventKinds(db: DB): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'traces'`).get() as { sql?: string } | undefined;
  if (row?.sql?.includes("'compaction'")) return;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => db.exec(`
      CREATE TABLE traces_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('session_init', 'user_prompt', 'tool_use', 'assistant_message', 'compaction', 'session_end')),
        tool_name TEXT, tool_input TEXT, tool_output TEXT, files_read TEXT, files_modified TEXT,
        user_prompt TEXT, final_response TEXT, redaction_json TEXT NOT NULL DEFAULT '{}', processed_at INTEGER,
        pipeline_state TEXT DEFAULT 'captured', platform_event_id TEXT, content_hash TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1, ingested_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      INSERT INTO traces_next (id, session_id, timestamp, event_type, tool_name, tool_input, tool_output, files_read, files_modified, user_prompt, final_response, redaction_json, processed_at, pipeline_state, platform_event_id, content_hash, schema_version, ingested_at)
      SELECT id, session_id, timestamp, event_type, tool_name, tool_input, tool_output, files_read, files_modified, user_prompt, final_response, redaction_json, processed_at, pipeline_state, platform_event_id, content_hash, schema_version, ingested_at FROM traces;
      DROP TABLE traces;
      ALTER TABLE traces_next RENAME TO traces;
      CREATE INDEX idx_traces_session ON traces(session_id);
      CREATE INDEX idx_traces_timestamp ON traces(timestamp DESC);
      CREATE INDEX idx_traces_unprocessed ON traces(processed_at) WHERE processed_at IS NULL;
      CREATE INDEX idx_traces_pipeline_state ON traces(pipeline_state);
      CREATE UNIQUE INDEX idx_traces_platform_event ON traces(session_id, platform_event_id) WHERE platform_event_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_traces_replay ON traces(session_id, event_type, timestamp, content_hash) WHERE platform_event_id IS NULL AND content_hash IS NOT NULL;
    `))();
  } finally { db.pragma("foreign_keys = ON"); }
}

function ensureEventLedgerColumns(db: DB): void {
  addColumnIfMissing(db, "traces", "platform_event_id", "TEXT");
  addColumnIfMissing(db, "traces", "content_hash", "TEXT");
  addColumnIfMissing(db, "traces", "schema_version", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "traces", "ingested_at", "INTEGER");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_traces_platform_event
      ON traces(session_id, platform_event_id) WHERE platform_event_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_traces_replay
      ON traces(session_id, event_type, timestamp, content_hash)
      WHERE platform_event_id IS NULL AND content_hash IS NOT NULL;
  `);
}

function ensureFeedbackEventKinds(db: DB): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_feedback'`)
    .get() as { sql?: string } | undefined;
  if (row?.sql?.includes("'harmful'")) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE memory_feedback RENAME TO memory_feedback_legacy;
      DROP INDEX IF EXISTS idx_memory_feedback_memory;
      DROP INDEX IF EXISTS idx_memory_feedback_context;
      CREATE TABLE memory_feedback (
        id TEXT PRIMARY KEY,
        memory_id INTEGER NOT NULL REFERENCES memories(id),
        doc_id TEXT,
        event_type TEXT NOT NULL CHECK(event_type IN
          ('shown', 'used', 'helpful', 'harmful', 'ignored', 'downranked', 'corrected')),
        weight REAL NOT NULL,
        source TEXT NOT NULL,
        context_injection_id TEXT,
        correction_text TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO memory_feedback (
        id, memory_id, doc_id, event_type, weight, source,
        context_injection_id, correction_text, created_at
      )
      SELECT
        id, memory_id, doc_id, event_type, weight, source,
        context_injection_id, correction_text, created_at
      FROM memory_feedback_legacy;
      DROP TABLE memory_feedback_legacy;
      CREATE INDEX idx_memory_feedback_memory ON memory_feedback(memory_id);
      CREATE INDEX idx_memory_feedback_context ON memory_feedback(context_injection_id);
    `);
  })();
}

function ensureContextCandidateKinds(db: DB): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_candidates'`)
    .get() as { sql?: string } | undefined;
  if (row?.sql?.includes("'observation'")) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE context_candidates RENAME TO context_candidates_legacy;
      DROP INDEX IF EXISTS idx_context_candidates_selected;
      CREATE TABLE context_candidates (
        packet_id TEXT NOT NULL REFERENCES context_packets(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN
          ('current_state', 'repository_knowledge', 'episode', 'summary', 'observation', 'memory', 'procedure', 'evidence')),
        source_id TEXT,
        token_estimate INTEGER NOT NULL,
        selected INTEGER NOT NULL CHECK(selected IN (0, 1)),
        rank INTEGER,
        final_score REAL NOT NULL,
        score_breakdown_json TEXT NOT NULL DEFAULT '{}',
        rejection_reason TEXT,
        rendered_text TEXT NOT NULL,
        PRIMARY KEY (packet_id, candidate_id)
      );
      INSERT INTO context_candidates SELECT * FROM context_candidates_legacy;
      DROP TABLE context_candidates_legacy;
      CREATE INDEX idx_context_candidates_selected ON context_candidates(packet_id, selected, rank);
    `);
  })();
}

function safeParseIntArray(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/**
 * Backfill the indexed trace_observations and observation_memories link tables
 * once from existing JSON provenance. Runs only when the link tables are empty
 * (i.e. the first migration after introduction), so it is a one-time O(N) scan
 * rather than a per-completion full-table scan. New inserts populate the link
 * tables going forward.
 */
function ensureProvenanceLinks(db: DB): void {
  const linkCount = (db.prepare(`SELECT COUNT(*) AS c FROM trace_observations`).get() as { c: number }).c;
  if (linkCount > 0) return;

  const obsCount = (db.prepare(`SELECT COUNT(*) AS c FROM observations`).get() as { c: number }).c;
  if (obsCount === 0) return;

  const insTO = db.prepare(`INSERT OR IGNORE INTO trace_observations (trace_id, observation_id) VALUES (?, ?)`);
  for (const o of db.prepare(`SELECT id, source_trace_ids FROM observations`).all() as Array<{ id: number; source_trace_ids: string }>) {
    for (const tid of safeParseIntArray(o.source_trace_ids)) insTO.run(tid, o.id);
  }
  const insOM = db.prepare(`INSERT OR IGNORE INTO observation_memories (observation_id, memory_id) VALUES (?, ?)`);
  for (const m of db.prepare(`SELECT id, source_observation_ids FROM memories`).all() as Array<{ id: number; source_observation_ids: string }>) {
    for (const oid of safeParseIntArray(m.source_observation_ids)) insOM.run(oid, m.id);
  }
}

/**
 * Create a vec0 virtual table for vector search using sqlite-vec.
 * Call this after sqlite-vec extension is loaded.
 * Falls back silently if the extension is not loaded.
 */
export function tryCreateVecTable(db: DB, dimensions: number): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        embedding float[${dimensions}]
      )
    `);
    return true;
  } catch {
    return false;
  }
}
