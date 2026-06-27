# Configuration

Termyte is configured by environment variables. There is no config file to ship. Every variable is optional; the defaults are designed to work for the common case.

## Storage

| Variable | Default | Purpose |
|---|---|---|
| `TERMYTE_DB` | `./termyte.db` | Path to the SQLite file. Use `:memory:` for tests, or a different path to keep the corpus in a project-local location. |

The database is opened with WAL mode and foreign keys ON. It is safe to run concurrent readers (e.g. the MCP server) alongside a single synth writer.

## Synthesis (LLM)

| Variable | Default | Purpose |
|---|---|---|
| `TERMYTE_SYNTH_ADAPTER` | auto-detect | Pin the synthesis adapter: `claude-code`, `codex`, `opencode`, or `gemini-cli`. Auto-detect probes in priority order. |
| `TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS` | `50` | Maximum synthesis invocations per UTC day. After this, the budget guard denies new invocations until the next day. |
| `TERMYTE_SYNTH_DAILY_BUDGET_USD` | `0.50` | Maximum estimated USD cost per UTC day. After this, the budget guard denies new invocations. |
| `TERMYTE_SYNTH_TIMEOUT_MS` | `300000` | Per-batch synthesis timeout (ms). The batch is aborted and the traces remain unprocessed. |
| `TERMYTE_SYNTH_BATCH_SIZE` | `50` | Max traces per `Batcher.runOnce` invocation. |
| `TERMYTE_SYNTH_MAX_BATCHES` | `5` | Max batches per `termyte synth` invocation. |

The budget guard is a hard cap. It is intentionally conservative — synthesis should never cost more than a coffee per day.

## Legacy observer (in-process LLM)

| Variable | Default | Purpose |
|---|---|---|
| `TERMYTE_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible chat completions base URL. Also reads `OPENAI_BASE_URL`. |
| `TERMYTE_LLM_API_KEY` | (none) | API key for the chat completions endpoint. Also reads `OPENAI_API_KEY`. |
| `TERMYTE_LLM_MODEL` | `gpt-4o-mini` | Model name to send. |

The legacy `Observer` is deprecated in favor of `termyte synth`. New code should use the `AgentAdapter` path; these variables are kept for compatibility and for the in-process `termyte-worker` CLI.

## Local embeddings

| Variable | Default | Purpose |
|---|---|---|
| `TERMYTE_EMBED_MODEL_LOCAL` | `nomic-embed` | Which ONNX model to load. `nomic-embed` (Nomic Embed Text v1.5, 768d) or `bge-small` (BGE Small EN v1.5, 384d). Models are downloaded once and cached locally by `@xenova/transformers`. |

Embeddings always run locally. There is no hosted-embeddings configuration. If the local model fails to load, `HybridSearch` catches the error and degrades to FTS-only results.

## Hook / install

| Variable | Default | Purpose |
|---|---|---|
| `TERMYTE_HOOK_PATH` | auto-detect | Override the path to the `termyte-hook` binary that the installers bake into the agent's hook config. |
| `TERMYTE_NODE_PATH` | auto-detect | Override the `node` binary that MCP-only installers bake into the IDE's `mcpServers` entry. |

The installers (`src/integrations/install-paths.ts`) resolve these at install time and bake absolute paths into the agent's config. You should not need to set either manually unless you have an unusual install layout.

## Where the data lives

| Path | Contents |
|---|---|
| `./termyte.db` (or `TERMYTE_DB`) | All five tables + FTS5 mirrors + optional sqlite-vec. |
| `./termyte.db-wal` / `termyte.db-shm` | SQLite WAL files. |
| `~/.config/termyte/spend.json` | Persistent spend log (SHA-256-checksummed). Read by `termyte stats`. |

## Default spend caps and how to raise them

The defaults — 50 invocations and $0.50 USD per day — assume the user is on a metered plan and wants to avoid surprises. To raise them:

```bash
# Up to 200 invocations and $2 per day
export TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS=200
export TERMYTE_SYNTH_DAILY_BUDGET_USD=2.00
```

To disable the cap entirely (not recommended):

```bash
export TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS=999999
export TERMYTE_SYNTH_DAILY_BUDGET_USD=999999
```

`termyte stats` shows the current day's invocations, tokens, and estimated cost as a percentage of these caps.

## Detecting your environment programmatically

The programmatic API is in `src/index.ts`. The `loadConfig()` function returns the resolved configuration:

```ts
import { loadConfig } from "termyte";
const config = loadConfig();
console.log(config.dbPath, config.embeddings.model);
```
