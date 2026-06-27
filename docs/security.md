# Security model

Termyte's threat model is the local developer machine. There is no network listener and there is no hosted component. The design choices below are what keep it that way.

## Network surface

Termyte opens zero inbound ports. The MCP server (`termyte mcp`) communicates over stdio only.

The only outbound network calls are:

1. The synthesis step, which invokes the user's coding-agent CLI (`claude -p`, `codex exec`, `opencode run`, or `gemini -p`). These calls go to the agent's normal endpoint — the same endpoint the user pays for — and are rate-limited by daily budget caps.
2. The first run of the embeddings model, which downloads a Nomic Embed or BGE model from the Hugging Face CDN via `@xenova/transformers`. After the first run, the model is cached locally.

There is no telemetry, no analytics, no usage ping, no error reporting service. `termyte stats` reads from the local database; it does not phone home.

## Local data

The corpus is a single SQLite file (`./termyte.db` or `$TERMYTE_DB`). It contains:

- Raw event payloads (tool input, tool output) for every captured hook.
- Extracted observations and consolidated memories with their embeddings.
- Session metadata.
- Spend data (invocation counts, token counts, estimated cost) in `~/.config/termyte/spend.json`.

The raw payloads can be sensitive. They may include command output, file contents, and the user's prompts. Treat `termyte.db` like a `.env` file — don't commit it, don't share it, don't attach it to a public bug report.

## Process boundaries

- `termyte-hook` runs in the agent's process and exits as soon as the handler completes. It never blocks on the LLM.
- `termyte synth` runs as a separate process. It holds an exclusive lock so two synth runs cannot fight over the same unprocessed traces.
- `termyte mcp` is single-process and synchronous. The store opens in WAL mode so it can coexist with synth and capture.

## Crash safety

- Traces are only marked `processed_at` **after** their derived observations are written. A crash mid-batch leaves the trace unprocessed and re-processable on the next run.
- The `Spend` module uses atomic temp-file rename and a SHA-256 checksum on the persistent spend log, so partial reads on FAT32/exFAT or after a power loss are detected and reported as "data unavailable" rather than silently showing $0.
- The `traces` table has a partial index on `processed_at IS NULL`, so the "find me the next batch" query is a cheap index probe.

## Boundedness

The synthesis step is intentionally bounded:

- **Per-batch cap** (`TERMYTE_SYNTH_BATCH_SIZE`, default 50). One batch is one LLM call.
- **Per-run cap** (`TERMYTE_SYNTH_MAX_BATCHES`, default 5). One `termyte synth` invocation does at most 5 LLM calls.
- **Per-batch timeout** (`TERMYTE_SYNTH_TIMEOUT_MS`, default 5 min). The subprocess is killed and the traces remain unprocessed.
- **Daily invocation cap** (`TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS`, default 50). The budget guard denies new invocations after this.
- **Daily USD cap** (`TERMYTE_SYNTH_DAILY_BUDGET_USD`, default $0.50). Same — once hit, new invocations are denied.

These caps exist so a misconfigured schedule or a runaway script cannot eat the user's LLM plan. They are configurable but the defaults are conservative.

## Install-time safety

The installers (`src/integrations/installers/`) always call `backupIfExists()` from `src/integrations/installers/backup.ts` before overwriting any pre-existing config. The backup is named `<original>.bak.<timestamp>`. A malformed config triggers a backup before the file is replaced with a known-good one.

The installer bakes the absolute path to the `termyte-hook` and `termyte mcp` binaries at install time. If you move the binary, re-run the installer.

## Input validation

- `cwd` from the agent's hook payload is validated via `isValidCwd()` from `src/capture/errors.ts`. An out-of-workspace cwd throws `AdapterRejectedInput` rather than being silently accepted.
- `tool_input` / `tool_output` are JSON-decoded with conservative parsers. They are not eval'd or template-interpolated.
- The LLM's XML output is parsed with the regex-based parser in `src/observer/parser.ts`. Code fences are stripped first. Unknown observation types fall back to `fact`.

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md) for the private disclosure process.

## Out-of-scope

- Reports that require the user to have already executed attacker-controlled code with full write access to `termyte.db`.
- Denial-of-service via local resource exhaustion (filling the SQLite file, etc.) by the local user.
- Theoretical LLM-prompt-injection scenarios that require the user to copy a malicious trace into their own database.
- Issues in upstream dependencies (`better-sqlite3`, `@xenova/transformers`, `sqlite-vec`). Please report those to the upstream maintainers.
