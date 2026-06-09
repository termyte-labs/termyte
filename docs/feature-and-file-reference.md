# Feature and File Reference

This reference covers the authored implementation, tests, scripts, fixtures,
documentation, and top-level project configuration. Generated `dist/`,
dependencies in `node_modules/`, Git internals, and local `.termyte/` state are
described by category rather than enumerated file by file.

## Feature Reference

### `termyte check "<command>"`

Evaluates command text without executing it, writes a SQLite ledger row, and
prints allow/warn/block JSON. It is the fastest way to see how Termyte classifies
command text.

### `termyte run -- <command>`

Runs the direct governed command gate. It parses, resolves targets, analyzes
blast radius, checks policy and memory, logs a pending ledger row, executes
only if allowed or approved, finalizes the ledger, and updates memory.

### `termyte mcp serve` and `termyte mcp install <agent>`

Starts Termyte's stdio MCP server or prints an agent-specific MCP config
snippet with `TERMYTE_WORKSPACE` pinned to the current repository. This is the
primary agent tool surface and uses the same parser/risk/policy/memory/ledger
pipeline as `run --`.

### `termyte run <agent>`

Launches a supported agent executable directly. It is a convenience launcher,
not a policy gate. Claude Code and Codex hook adapters remain optional and are
managed by `termyte install`, `termyte uninstall`, and `termyte agent hook`.

### `termyte policy presets|show|test`

Lists built-in YAML presets, shows the effective additive policy, or evaluates
policy without executing or writing a ledger row.

### `termyte policy global|local add "<rule>"`

Compiles a supported natural-language phrase into deterministic YAML. Dry run
shows output without writing; saving requires confirmation or `--yes`. This is
policy authoring, not part of the runtime execution path.

### `termyte logs`

Reads the SQLite replay ledger, with JSON output available via `--json`.

### `termyte memory`

Reads the SQLite semantic memory store.

### `termyte allow-once -- <command>`

Overrides a non-allow runtime decision except for protected, home, or
filesystem-root targets.

### `termyte inspect -- <command>`

Prints the direct runtime's parse, targets, risk, policy, memory, and final
decision without executing.

### `termyte prove-runtime [--json]`

Runs the deterministic readiness proof. It exercises allowed reads, blocked
destructive actions, warning paths, and replay verification against the local
runtime.

### `termyte policies`

Manages SQLite semantic block/warn lists for runtime policy. Supports show,
status, defaults, reset, set, add, remove, export, import, and validate.

### `termyte replay`

Formats SQLite ledger history chronologically.

### `termyte doctor`

Runs environment, workspace, policy/database health, optional agent executable,
and packaged asset checks.

### `termyte bench`

By default, evaluates 1,200 strictly labeled governance cases through the
stable check path and reports accuracy, precision/recall, a confusion matrix,
false-safe rate, and overblock rate. `--legacy` evaluates the older 230-case
compatibility fixture.

## Source Files

| File | Responsibility and main logic |
| --- | --- |
| `src/cli.ts` | CLI entry point and command dispatch. Owns argument parsing, approvals, and routing to the direct gate, MCP, policies, docs, and diagnostics. |
| `src/types.ts` | Shared domain contracts for decisions, parsed actions, targets, risk, ledger records, replay, and semantic memory. |
| `src/parser.ts` | Custom tokenizer, shell guesser, secret redaction call, semantic action recognition, flags, confidence, and generic fallback. |
| `src/resolver.ts` | Resolves filesystem delete targets, expands globs, checks workspace boundaries, classifies sensitivity, and estimates recoverability. |
| `src/risk.ts` | Deterministic baseline risk decisions and scores for all recognized action kinds. |
| `src/redact.ts` | Pattern-based command secret masking and environment-key-only collection. |
| `src/check.ts` | Stable non-executing inspection orchestration used by policy test and benchmark flows. |
| `src/policy-presets.ts` | Built-in YAML policy presets and their rules, including `safe-default`. |
| `src/policy-schema.ts` | Constrained YAML parser, schema validation, and policy document normalization. |
| `src/policy-loader.ts` | Loads built-in, global, and local YAML layers. Missing optional files are empty layers; invalid present files fail. |
| `src/policy-merge.ts` | Combines YAML layers and defines decision ordering: block, ask, warn, allow. |
| `src/policy-evaluator.ts` | Matches YAML rules against semantic IDs, command text, and paths, then combines matches with risk. |
| `src/policy-nl.ts` | Deterministic supported-phrase compiler, YAML formatter, preview generator, duplicate-name handling, and file append logic. |
| `src/policy-cli.ts` | User-facing YAML policy formatting, policy-only tests, natural-language add planning, and compact check JSON. |
| `src/mcp.ts` | Stdio MCP server, tool registry, MCP install config generation, and governed tool-call dispatch. |
| `src/proof.ts` | Deterministic runtime proof command and formatted readiness output. |
| `src/agent.ts` | Parses agent run invocation, resolves supported agent binaries and aliases, and defines direct-launch profiles. |
| `src/agent-runner.ts` | Direct agent launcher. Resolves the executable, prepares local runtime state, and spawns the agent without shell shims. |
| `src/agent-hook.ts` | Optional Claude Code/Codex hook adapter install, uninstall, verification, and hook CLI bridge. |
| `src/runtime.ts` | Direct-command orchestration: analysis, policy, semantic memory lookup, ledger pending row, approval/block/execute, finalization, and memory observation. |
| `src/policy.ts` | SQLite semantic policy defaults, evaluation, persistence, mutation, JSON import/export, validation, metadata, and drift analysis. |
| `src/db.ts` | Creates/opens `.termyte/termyte.db`, enables WAL, creates ledger/memory/policy tables, and performs small schema migrations. |
| `src/ledger.ts` | Creates pending runtime rows, finalizes outcomes, updates heartbeats, lists/replays records, and recovers stale shim executions for legacy compatibility. |
| `src/memory.ts` | SQLite semantic operational memory: aggregate observation, fuzzy semantic matching, confidence, lessons, and false-positive feedback. |
| `src/execute.ts` | Synchronous direct command execution through PowerShell, cmd, or sh after runtime approval. |
| `src/format.ts` | Human tables and formatting for SQLite logs, replay, inspections, and semantic memory. |
| `src/doctor.ts` | Comprehensive readiness diagnostics with human and JSON reports and PASS/WARN/FAIL classification. |
| `src/benchmark.ts` | Loads and validates governance/legacy fixtures, runs the appropriate decision engine, and calculates accuracy, confusion, precision/recall, false-safe, overblock, and category metrics. |
| `src/shell.ts` | Isolated experimental governed-session implementation kept out of the default runtime path. |
| `src/local-state.ts` | Legacy JSONL state helpers retained for compatibility surfaces, not the default runtime path. |
| `src/local-logs.ts` | Legacy JSONL log writer retained for compatibility surfaces, not the default runtime path. |
| `src/local-memory.ts` | Legacy exact-feedback helper retained for compatibility surfaces, not the default runtime path. |

## Test Files

| File | What it verifies |
| --- | --- |
| `test/check-cli.test.ts` | Stable check and YAML policy CLI behavior, including no execution. |
| `test/logs-memory.test.ts` | SQLite ledger and semantic memory behavior for direct check and runtime actions. |
| `test/policy-schema.test.ts` | Supported YAML schema acceptance and rejection. |
| `test/policy-loader.test.ts` | Built-in/global/local YAML loading and invalid-file failure. |
| `test/policy-merge.test.ts` | Strongest-decision conflict resolution and inability to weaken built-in blocks. |
| `test/policy-nl.test.ts` | Supported deterministic natural-language compilation, dry runs, saves, preservation, duplicates, and rejection. |
| `test/agent-run.test.ts` | Direct agent invocation planning, aliases, profiles, and direct-launch behavior. |
| `test/parser-risk.test.ts` | Parser, resolver, risk, SQLite runtime ledger, redaction, semantic memory matching, and false-positive behavior. |
| `test/policy-update.test.ts` | SQLite policy persistence, runtime application, import/export, validation, and drift. |
| `test/mcp.test.ts` | MCP tool dispatch, inspection, and direct runtime-backed command execution. |
| `test/doctor.test.ts` | Doctor output, optional-tool warnings, packaged asset resolution, Windows environment checks, policy state, and drift warnings. |
| `test/benchmark.test.ts` | Governance fixture size/balance/uniqueness, invalid-fixture rejection, metric calculation, and stable check-path evaluation without log writes. |

## Scripts and Data

| File | Responsibility |
| --- | --- |
| `benchmarks/commands.json` | Generated 230-case benchmark input and expected decisions. |
| `benchmarks/governance.json` | Generated 1,200-case balanced governance fixture with strict decisions, metadata, tags, and rationales. |
| `scripts/generate-benchmarks.mjs` | Recreates the benchmark case file and asserts exactly 230 cases. |
| `scripts/generate-governance-benchmarks.mjs` | Recreates the balanced governance fixture and asserts count, decision balance, command uniqueness, and ID uniqueness. |
| `scripts/validate-package.mjs` | Builds, packs, installs into a temporary prefix, runs CLI/doctor/check/policy/memory/log/agent/bench/demo smoke tests, and checks for state leakage. |
| `package.json` | Package identity, Node >=20 requirement, CLI bin, included publish files, dependencies, and build/test/package-validation scripts. |
| `package-lock.json` | Locked npm dependency graph used for reproducible installs. |
| `tsconfig.json` | TypeScript compiler configuration. |
| `README.md` | Public alpha overview and command quickstart. |
| `CHANGELOG.md` | Current release-level capabilities and limitations. |
| `LICENSE` | MIT license terms for the repository. |
| `.gitignore` | Excludes dependencies, generated build output, local Termyte state, and package archives from Git. |
| `docs/demo.md` | Safe repeatable non-executing alpha demo. |
| `docs/benchmark.md` | Governance benchmark methodology and claim boundary. |
| `AGENTS.md` | Repository build scope, required modules, safety rules, commands, and explicit non-goals for coding agents. |

## Documentation Files

| File | Purpose |
| --- | --- |
| `docs/README.md` | Documentation index and concise product boundary. |
| `docs/project-description.md` | Detailed project description, implemented capabilities, product boundary, and rationale. |
| `docs/architecture-and-runtime-logic.md` | End-to-end architecture, decision logic, policy enforcement, blocking, memory, ledger, and trust boundaries. |
| `docs/feature-and-file-reference.md` | Complete feature and authored-file reference. |
| `docs/benchmark.md` | Governance benchmark methodology and claim boundary. |
| `docs/demo.md` | Safe repeatable alpha demo. |

## Runtime State Files

| Path | Produced by | Contents |
| --- | --- | --- |
| `.termyte/termyte.db` | Runtime, policies | SQLite ledger, semantic memory, and runtime policy state. |
| `termyte.policy.yaml` | Local YAML policy | Repository policy presets and explicit rules. |
| `~/.termyte/policy.yaml` or `TERMYTE_HOME/policy.yaml` | Global YAML policy | User-level policy presets and explicit rules. |

## SQLite Tables

### `ledger`

Stores one row per runtime or check action. Rows are created as pending before
execution and finalized with decision, risk, status, output, exit code, and
metadata.

### `memory_entries`

Stores aggregate semantic action outcomes keyed by semantic ID and workspace.
Tracks total, allow, warn, block, fail, false-positive counts, confidence, and
last outcome.

### `policy_state`

Stores one active SQLite semantic policy set, default-policy version,
customized flag, and update timestamp.

## Generated and Dependency Directories

| Path | Role |
| --- | --- |
| `dist/` | TypeScript build output used by the published CLI. |
| `node_modules/` | Installed dependencies. |
| `.git/` | Repository history and metadata; treated as a protected delete target. |
