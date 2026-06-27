# Troubleshooting

This page is organized by symptom. If your problem isn't here, run `termyte stats` first — most issues show up in the output.

## `termyte install <platform>` fails

**"could not locate the termyte-hook entry script"**

The installer bakes the absolute path to `termyte-hook` at install time. If the binary moved (e.g. you upgraded Node and the global install path changed), re-run the installer:

```bash
npm install -g termyte
termyte install <platform>
```

You can override the path manually with `TERMYTE_HOOK_PATH` (and `TERMYTE_NODE_PATH` for MCP-only installers) before running the install.

**"malformed settings.json — backed up to ..."**

The installer always creates a `.bak.<timestamp>` backup before overwriting a pre-existing config that fails to parse. Restore the backup if you need the old config, or delete the `.bak` once you've confirmed the install is correct.

**"unknown platform 'foo'"**

Run `termyte help` to see the supported platforms. The list is `claude-code, cursor, codex, gemini-cli, windsurf, opencode, mcp:copilot-cli, mcp:antigravity, mcp:goose, mcp:roo-code, mcp:warp`.

## The hook fires but no traces are written

**Agent is running but `termyte stats` shows 0 unprocessed traces.**

1. Confirm the hook is registered. For Claude Code, check `~/.claude/settings.json` for a `hooks` key. For Codex, `~/.codex/hooks.json`. For Cursor, `~/.cursor/hooks.json`. The path differs per agent — see [Agent setup](./agents.md).
2. Run the hook manually with a sample payload. The hook reads JSON on stdin, so:
   ```bash
   echo '{"session_id":"test","cwd":"/tmp","tool_name":"Read"}' | termyte-hook claude-code
   ```
   If the hook is wired correctly, this writes one trace to `termyte.db`.
3. Check `termyte trace 1 --json` — the first row should be your test payload.
4. Check the agent's own log for "hook failed" or "hook error" messages. Some agents swallow hook errors.

**The hook fires but termyte logs an error to stderr.**

The error message tells you what went wrong. Common cases:

- `adapter rejected input (invalid_cwd)` — the agent's `cwd` is outside the expected workspace. The agent's hook payload has a `cwd` that termyte doesn't trust. Run the agent from a real project directory.
- `ingest failed: FOREIGN KEY constraint failed` — the session was not upserted before the trace was inserted. This is rare; please open an issue.
- `ingest failed: ...` with a SQLite error — usually a corrupted DB. Try `termyte stats` and check that the DB file is not 0 bytes.

## `termyte synth` is a no-op

**"no unprocessed traces"** but you just used the agent.

The hook isn't running. See the previous section.

**"no synthesis adapter found"**

The `discoverAdapter()` step couldn't find any of `claude`, `codex`, `opencode`, or `gemini` on `PATH`. Solutions:

- Install one of those CLIs. Termyte borrows its plan.
- If the binary is installed but not on `PATH`, set `TERMYTE_SYNTH_ADAPTER` explicitly and use the env-var override on the adapter (e.g. `CLAUDE_PATH`).
- If you'd rather not synthesize, just use the corpus for direct FTS5 search via `termyte search` and skip synthesis entirely.

**The synth call hangs.**

The subprocess is probably waiting on the LLM. Check the timeout — `TERMYTE_SYNTH_TIMEOUT_MS` defaults to 5 min. If the call is legitimately slow, raise the timeout. If it's stuck, kill the process and check the agent CLI manually.

## `termyte search` returns no results

**The corpus is empty.**

Run `termyte stats` to check. If `unprocessed traces: 0` and `recent sessions: 0`, you haven't captured any traces yet. Run the agent and try again.

**The corpus has data but the query returns nothing.**

- The FTS5 query is tokenized on whitespace and punctuation. Try shorter, more specific terms.
- The query terms may not appear in any memory's title or description. Try `termyte memories` to browse what you have.
- If you only have traces (no synthesis), search will return 0 results — synthesis is what turns traces into searchable memories.

**"embedding model not ready"**

The first call to `termyte search` loads the ONNX model. This takes a few seconds and downloads ~100 MB. Subsequent calls are fast. The model is cached in `~/.cache/huggingface/`.

## The MCP server can't be reached

**The IDE says "spawn failed" or "command not found".**

The installer bakes the absolute path to `node` and the `termyte` binary. If you moved either, re-run the installer. To verify the path manually:

```bash
which node
which termyte
# Both should print absolute paths
```

**Tools return `isError: true`.**

The error message is in the response. Common cases:

- `(missing required argument: query)` — `search_memories` requires a `query` argument.
- `(no memory with id N)` — the `id` doesn't exist. `termyte memories` will list valid ids.
- `(embedding model not ready)` — the local ONNX model is still loading on first call. Try again.

## Performance is slow

**First `termyte search` is slow.**

The ONNX model is downloading and loading. One-time cost; subsequent calls are fast.

**`termyte synth` is slow.**

By design. Synthesis reuses the LLM plan you're already paying for. If you want faster synthesis, run smaller batches (`--batch-size 10`) more often (cron every 5 min) instead of one big batch per hour.

**The `termyte.db` file is huge.**

`VACUUM` it: `sqlite3 termyte.db VACUUM;`. Termyte never deletes rows, so the file grows monotonically. Run `VACUUM` periodically if disk space matters. (In WAL mode, the WAL files can also grow; check `termyte.db-wal` size.)

## Data integrity issues

**A trace has `ingest_status: 'failed'`.**

The trace hit an error during ingest and was preserved with the error message in `ingest_error`. This is by design — it lets you see what failed rather than silently dropping it. Fix the underlying error (often a malformed payload) and delete the trace:

```bash
sqlite3 termyte.db "DELETE FROM traces WHERE ingest_status = 'failed';"
```

**A memory has the wrong content.**

Delete and re-synthesize. Memories are derived data, not source of truth.

```bash
# Find the id
termyte memories --limit 100 | grep "the title"
# Delete it
sqlite3 termyte.db "DELETE FROM memories WHERE id = 42;"
# The traces that fed it are still there; re-running termyte synth will regenerate it.
```

## Logs and diagnostics

`termyte` itself doesn't have a separate log file. Operational state is in the `traces` table (with `ingest_status`, `ingest_error`, `ingest_attempts`) and in the spend log at `~/.config/termyte/spend.json`. The agent's own log is usually the best place to see what the hook is doing.

For deeper diagnostics, set `DEBUG=termyte:*` in the agent's env. Termyte doesn't currently emit debug logs, but the underlying `better-sqlite3` and `@xenova/transformers` libraries do.

## Resetting everything

To start over from scratch:

```bash
# Stop the agent (so it's not writing to the DB while you delete it)
rm -f termyte.db termyte.db-wal termyte.db-shm
# Uninstall the hooks (or restore the installer backup)
# Re-run termyte install <platform>
```

The corpus is fully derived from the agent's behavior — there is no state to lose that can't be regenerated by using the agent again.
