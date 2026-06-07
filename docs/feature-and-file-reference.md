# Feature and File Reference

This reference covers the authored implementation, tests, scripts, fixtures,
documentation, and top-level project configuration. Generated `dist/`,
dependencies in `node_modules/`, Git internals, local `.termyte/` state, and
historical working artifacts outside `docs/` are described by category rather
than enumerated file by file.

## Feature Reference

### `termyte check [--json] "<command>"`

Evaluates command text without execution. Uses shared parsing/risk logic, YAML
policy layers, exact JSONL memory, and writes a JSONL check event. Needed as the
safest and most predictable entry point for seeing what Termyte understands.

### `termyte policy presets|show|test`

Lists built-in YAML presets, shows the effective additive policy, or evaluates
policy without applying memory or writing a check log. Needed to make policy
behavior visible and testable before relying on it.

### `termyte policy global|local add "<rule>"`

Compiles a supported natural-language phrase into deterministic YAML. Dry run
shows output without writing; saving requires confirmation or `--yes`. Needed
to make common local policy creation approachable without hiding generated
rules.

### `termyte logs`

Reads `.termyte/logs.jsonl`, with blocked, warned, agent, today, and JSON
filters. Needed for lightweight inspection of stable check decisions.

### `termyte memory`, `mark-safe`, and `mark-unsafe`

Reads or writes exact command feedback in `.termyte/memory.jsonl`. Unsafe
matches can make future checks more cautious. Needed for explicit local user
feedback without automatic policy weakening.

### `termyte run -- <command>`

Evaluates and may execute one command through the SQLite runtime. Warnings
require approval; blocks do not execute. Needed as the direct governed-command
primitive.

### `termyte allow-once -- <command>`

Overrides a non-allow runtime decision except for protected, home, or
filesystem-root targets. Needed for explicit one-time exceptions while
retaining hard-critical protection.

### `termyte inspect -- <command>`

Prints the SQLite runtime's parse, targets, risk, policy, memory, and final
decision without executing. Needed to explain direct-runtime decisions.

### `termyte prove-runtime [--json]`

Runs the deterministic launch-readiness proof. It exercises allowed reads,
blocked destructive actions, warning paths, and replay verification against
the local runtime. Needed as the quickest way to verify governed launch
surface health on the current machine.

### `termyte mcp serve` and `termyte mcp install <agent>`

Starts Termyte's stdio MCP server or prints an agent-specific MCP config
snippet with `TERMYTE_WORKSPACE` pinned to the current repository. Needed to
route coding-agent tool calls through governed Git, filesystem, shell,
package, policy, replay, and proof tools.

### `termyte install <claude|codex>` and `termyte codex|claude`

Installs local native hook configuration for Claude Code or Codex, then
launches supported coding agents after preparing YAML policy, JSONL logs and
memory, repository context, session environment variables, command shims, shell
hooks, and a local guard daemon. Top-level agent commands are aliases for the
governed `run <agent>` path. Native hook events and agent subprocesses that hit
supported shimmed tools are evaluated before execution and written to the
SQLite ledger. This remains interception rather than a full sandbox.

### `termyte shell`

Starts the experimental governed shell/session with shims, hooks, guard daemon,
SQLite ledger, semantic memory, integrity checks, and fail-closed interception.
Needed as the lower-level interception primitive.

### Runtime proof surface

`termyte prove-runtime` is the deterministic readiness check for the governed
local runtime. It is the fastest way to show that allowed reads, blocked
destructive actions, and replay verification all behave as expected.

### `termyte policies`

Manages SQLite semantic block/warn lists for runtime and shell execution.
Supports show, status, defaults, reset, set, add, remove, export, import, and
validate. Needed for execution-path policy and explicit drift management.

### `termyte replay`

Formats SQLite ledger history chronologically, including correlated hook/shim
activity. Needed to reconstruct what the experimental runtime evaluated and
executed.

### `termyte doctor`

Runs environment, workspace, policy, shell runtime, optional tool, and package
checks. Needed because static configuration does not prove that guard IPC,
shims, executable resolution, or packaged assets actually work.

### `termyte bench`

By default, evaluates 1,200 strictly labeled governance cases through the stable
check path and reports accuracy, precision/recall, confusion, false-safe, and
overblock metrics. `--legacy` evaluates the older 230-case runtime fixture.
Needed for deterministic classification regression testing. Each suite
validates its own case set, not universal safety coverage.

## Source Files

| File | Responsibility and main logic |
| --- | --- |
| `src/cli.ts` | CLI entry point and command dispatch. Owns argument parsing, benchmark execution, interactive approvals, and routing to both generations of policy/log/memory behavior. |
| `src/types.ts` | Shared domain contracts for decisions, parsed actions, targets, risk, ledger records, replay, SQLite memory, and JSONL state. |
| `src/parser.ts` | Custom tokenizer, shell guesser, secret redaction call, semantic action recognition, flags, confidence, and generic fallback. |
| `src/resolver.ts` | Resolves filesystem delete targets, expands globs, checks workspace boundaries, classifies sensitivity, and estimates recoverability. |
| `src/risk.ts` | Deterministic baseline risk decisions and scores for all recognized action kinds. |
| `src/redact.ts` | Pattern-based command secret masking and environment-key-only collection. |
| `src/check.ts` | Stable non-executing check orchestration: shared analysis, YAML policy, JSONL memory adjustment, result formatting, and event write. |
| `src/policy-presets.ts` | Built-in YAML policy presets and their rules, including `safe-default`. |
| `src/policy-schema.ts` | Constrained YAML parser, schema validation, and policy document normalization. Rejects unknown fields and malformed rules. |
| `src/policy-loader.ts` | Loads built-in, global, and local YAML layers. Missing optional files are empty layers; invalid present files fail. |
| `src/policy-merge.ts` | Combines YAML layers and defines decision ordering: block, ask, warn, allow. |
| `src/policy-evaluator.ts` | Matches YAML rules against semantic IDs, command text, and paths, then combines matches with risk. |
| `src/policy-nl.ts` | Deterministic supported-phrase compiler, YAML formatter, preview generator, duplicate-name handling, and file append logic. |
| `src/policy-cli.ts` | User-facing YAML policy formatting, policy-only tests, natural-language add planning, and compact check JSON. |
| `src/mcp.ts` | Stdio MCP server, tool registry, MCP install config generation, and governed tool-call dispatch. |
| `src/proof.ts` | Deterministic runtime proof command and formatted readiness output. |
| `src/local-state.ts` | Paths and generic JSONL read/write/append helpers for repo-local stable state. |
| `src/local-logs.ts` | Writes, filters, sorts, and formats `.termyte/logs.jsonl`. |
| `src/local-memory.ts` | Stores, lists, exactly matches, and formats user safe/unsafe JSONL memory. |
| `src/agent.ts` | Parses agent run invocation, resolves supported agent binaries and aliases, and defines runtime profiles and metadata. |
| `src/agent-runner.ts` | Governed agent launcher. Finds repository root, validates JSONL state/policy readiness, prints runtime readiness, and launches the agent through `launchGovernedSession`. |
| `src/runtime.ts` | SQLite direct-command orchestration: analysis, policy, semantic memory lookup, ledger pending row, approval/block/execute, finalization, and memory observation. |
| `src/policy.ts` | SQLite semantic policy defaults, evaluation, persistence, mutation, JSON import/export, validation, metadata, and drift analysis. |
| `src/db.ts` | Creates/opens `.termyte/termyte.db`, enables WAL, creates ledger/memory/policy tables, and performs small schema migrations. |
| `src/ledger.ts` | Creates pending runtime rows, finalizes outcomes, updates heartbeats, lists/replays records, and recovers stale shim executions. |
| `src/memory.ts` | SQLite semantic operational memory: aggregate observation, fuzzy semantic matching, confidence, lessons, and false-positive feedback. |
| `src/execute.ts` | Synchronous direct command execution through PowerShell, cmd, or sh after runtime approval. |
| `src/shell.ts` | Experimental governed-session implementation: session state, PATH shims, shell hooks, manifest integrity, guard daemon, decisions, approvals, real executable resolution, heartbeats, finalization, and stale recovery. |
| `src/format.ts` | Human tables and formatting for SQLite logs, replay, inspections, and semantic memory. |
| `src/doctor.ts` | Comprehensive readiness diagnostics with human and JSON reports and PASS/WARN/FAIL classification. |
| `src/benchmark.ts` | Loads and validates governance/legacy fixtures, runs the appropriate decision engine, and calculates accuracy, confusion, precision/recall, false-safe, overblock, and category metrics. |

## Test Files

| File | What it verifies |
| --- | --- |
| `test/check-cli.test.ts` | Stable check and YAML policy CLI behavior, including no execution. |
| `test/logs-memory.test.ts` | JSONL logs, filters, safe/unsafe memory, and memory decision constraints. |
| `test/policy-schema.test.ts` | Supported YAML schema acceptance and rejection. |
| `test/policy-loader.test.ts` | Built-in/global/local YAML loading and invalid-file failure. |
| `test/policy-merge.test.ts` | Strongest-decision conflict resolution and inability to weaken built-in blocks. |
| `test/policy-nl.test.ts` | Supported deterministic natural-language compilation, dry runs, saves, preservation, duplicates, and rejection. |
| `test/agent-runner.test.ts` | Limited agent readiness, launch behavior, missing executable handling, and invalid policy failure. |
| `test/agent-run.test.ts` | Agent invocation planning, aliases, profiles, dry-run output, and governed-session metadata behavior. |
| `test/parser-risk.test.ts` | Parser, resolver, risk, SQLite runtime ledger, redaction, semantic memory matching, and false-positive behavior. |
| `test/policy-update.test.ts` | SQLite policy persistence, runtime application, import/export, validation, and drift. |
| `test/shell.test.ts` | Governed session, shims, hooks, integrity, fail-closed behavior, correlation, ledger lifecycle, heartbeat recovery, executable resolution, Windows wrappers, isolation, and socket cleanup. |
| `test/doctor.test.ts` | Doctor output, optional-tool warnings, packaged asset resolution, Windows environment checks, policy state, nested shims, stale rows, and drift warnings. |
| `test/benchmark.test.ts` | Governance fixture size/balance/uniqueness, invalid-fixture rejection, metric calculation, and stable check-path evaluation without log writes. |

## Scripts and Data

| File | Responsibility |
| --- | --- |
| `benchmarks/commands.json` | Generated 230-case benchmark input and expected decisions. |
| `benchmarks/governance.json` | Generated 1,200-case balanced governance fixture with strict decisions, metadata, tags, and rationales. |
| `scripts/generate-benchmarks.mjs` | Recreates the benchmark case file and asserts exactly 230 cases. |
| `scripts/generate-governance-benchmarks.mjs` | Recreates the balanced governance fixture and asserts count, decision balance, command uniqueness, and ID uniqueness. |
| `scripts/validate-package.mjs` | Builds, dry-packs, checks allowed package contents, installs into a temporary prefix, runs CLI/doctor/check/policy/memory/log/agent/bench/demo smoke tests, and checks for state leakage. |
| `package.json` | Package identity, Node >=20 requirement, CLI bin, included publish files, dependencies, and build/test/package-validation scripts. |
| `package-lock.json` | Locked npm dependency graph used for reproducible installs. |
| `tsconfig.json` | TypeScript compiler configuration. |
| `README.md` | Public alpha overview and command quickstart. |
| `CHANGELOG.md` | Current release-level capabilities and limitations. |
| `LICENSE` | MIT license terms for the repository. |
| `.gitignore` | Excludes dependencies, generated build output, local Termyte state, logs, and package archives from Git. |
| `docs/demo.md` | Safe repeatable non-executing alpha demo. |
| `docs/benchmark.md` | Governance benchmark methodology, metrics, compatibility suite, and claim boundary. |
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
| `.termyte/logs.jsonl` | Stable `check` path | Append-only redacted check events. |
| `.termyte/memory.jsonl` | `mark-safe` / `mark-unsafe` | Exact redacted user feedback patterns. |
| `.termyte/termyte.db` | Runtime, shell, policies | SQLite ledger, semantic memory, and runtime policy state. |
| `.termyte/sessions/<id>/shims` | Governed shell | Generated command interception scripts. |
| `.termyte/sessions/<id>/shim-manifest.json` | Governed shell | Expected shim names, hashes, and sizes for integrity checks. |
| `termyte.policy.yaml` | Local YAML policy | Repository policy presets and explicit rules. |
| `~/.termyte/policy.yaml` or `TERMYTE_HOME/policy.yaml` | Global YAML policy | User-level policy presets and explicit rules. |

## SQLite Tables

### `ledger`

Stores one row per runtime, shell-hook, or shell-shim action. Rows are created
as `pending`/`planned` before execution and finalized with decision, risk,
status, output, exit code, and metadata.

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
