# Project Description

## What Termyte Is

Termyte is a local-first runtime safety and operational memory layer for AI
coding agents and risky developer commands. It is built as a Node.js and
TypeScript command-line application backed by local files and SQLite. It does
not require an account, a hosted service, or an LLM to make safety decisions.
It also includes a local MCP gateway and a deterministic runtime proof
command for launchability checks.

The product exists because coding agents can execute commands faster and more
frequently than a human can review them. A command such as `npm test` is
routine, while `rm -rf *`, `git push --force origin main`, `cat .env`, or
`DROP TABLE users` can have a large or irreversible impact. Termyte places a
deterministic decision layer between a proposed action and execution:

```text
command
  -> parse semantic action
  -> resolve targets
  -> analyze blast radius and risk
  -> enforce local policy
  -> consult operational memory
  -> allow, warn, ask, or block
  -> execute only through an execution surface
  -> record the result
  -> update memory
```

Termyte is not an AI judge. It does not trust an agent's reasoning or ask an
LLM whether an action is safe. Its critical path uses explicit parsing,
path classification, risk rules, policy matchers, and local state.

## The Problem It Solves

Developer tools and coding agents normally inherit the user's permissions.
That makes agents productive, but it also means a mistaken or overly broad
command can delete source code, expose secrets, rewrite Git history, publish a
package, alter infrastructure, or modify a database.

Termyte provides four practical controls:

1. **Pre-execution understanding.** It converts known command forms into
   semantic actions such as `git.push.force`, `secret.access`, or
   `filesystem.delete.recursive.force.wildcard`.
2. **Deterministic policy.** Built-in and user-authored rules decide whether
   matching actions should be allowed, warned, asked about, or blocked.
3. **Operational evidence.** Logs and the SQLite ledger explain what Termyte
   saw, why it made a decision, and what happened afterward.
4. **Local memory.** Users can mark exact command patterns safe or unsafe, and
   the runtime can retain aggregate outcomes for semantic action patterns.

These controls are intended to let developers grant agents more autonomy while
keeping dangerous or unusual actions visible and reviewable.

## What Is Implemented

### Stable Non-Executing Checks

`termyte check "<command>"` evaluates command text without executing it. It
parses the command, resolves visible filesystem targets, runs risk analysis,
loads built-in/global/local YAML policy, applies exact unsafe memory, writes a
repo-local JSONL event, and returns a decision. This is the safest way to
inspect current classification behavior.

`termyte mcp serve` exposes Termyte-controlled Git, filesystem, shell,
package, policy, replay, and proof tools over stdio MCP. `termyte mcp install
<agent>` prints a repository-pinned config snippet with `TERMYTE_WORKSPACE`
set to the current checkout so the gateway evaluates against the intended
workspace.

`termyte prove-runtime` runs a deterministic readiness proof. It exercises a
known allowed read, known blocked destructive actions, a warning path, and
ledger replay checks. This is the strongest current launchability check.

### Local Policy

Termyte includes a `safe-default` preset and optional global and repository
YAML policy files. Rules can match semantic IDs, normalized command patterns,
and resolved paths. When multiple rules and risk decisions apply, the strongest
decision wins:

```text
block > ask > warn > allow
```

Termyte also has deterministic natural-language policy creation for a limited
set of supported phrases. It translates recognized requests into visible YAML;
it does not use an LLM or accept arbitrary natural language.

### Command Risk Analysis

The parser currently recognizes:

- filesystem deletes;
- Git push and destructive history operations;
- package publishing;
- secret access;
- remote script execution;
- privilege escalation;
- destructive Docker operations;
- deployment mutations;
- destructive SQL;
- generic shell commands.

The resolver expands up to 100 filesystem glob results and classifies targets
such as repository metadata, source, configuration, dependency trees, build
output, the workspace root, the home directory, and filesystem roots. The risk
engine then combines action type, flags, target count, sensitivity,
recoverability, and workspace boundaries.

### Operational Records and Memory

The stable check path writes `.termyte/logs.jsonl`. Users can store exact safe
or unsafe command patterns in `.termyte/memory.jsonl`. Unsafe memory can upgrade
an otherwise allowed check to a warning. Safe memory never weakens a policy or
risk block.

The experimental execution runtime uses `.termyte/termyte.db`. Its ledger
creates a pending record before execution and finalizes it after a block,
failure, or completed command. Its semantic memory aggregates outcomes by
semantic ID and workspace, supports fuzzy semantic matching, and records false
positive feedback. Runtime memory adds context to explanations but does not
currently change the final runtime decision.

### Execution and Interception

`termyte run -- <command>` sends one command through the SQLite-backed runtime.
The command is analyzed before execution, warnings require interactive
approval, blocks do not execute, and every runtime action is written to the
ledger and observed by runtime memory.

`termyte shell` creates an experimental governed session. It generates command
shims, prepends them to `PATH`, starts a local guard daemon, injects supported
shell hooks, verifies shim integrity, evaluates intercepted commands, and
finalizes ledger records after execution. The shim path fails closed when it
cannot reach the guard.

`termyte install claude`, `termyte install codex`, `termyte claude`,
`termyte codex`, and `termyte run <agent>` form the first native agent runtime
surface. The install commands write local hook configuration for Claude Code or
Codex. The run path launches supported agents through `launchGovernedSession`,
which creates command shims, prepends the shim directory to `PATH`, starts the
guard daemon, installs supported shell hooks, records an agent-launch ledger
row, and evaluates native hook events and supported subprocess tool calls before
execution. The top-level agent commands are aliases for the governed
`run <agent>` path.

`termyte mcp serve` is the launchable governed tool surface for agents that
support MCP. It is the cleanest path for action governance today because it
executes Termyte-controlled tools directly instead of relying only on inherited
shell interception.

### Diagnostics and Validation

`termyte doctor` checks the local environment, workspace, SQLite state, policy
state, shell runtime setup, shim integrity, guard IPC, shim smoke execution,
nested shim resolution, optional tools, and packaged assets.

The primary governance benchmark contains 1,200 strictly labeled cases and
evaluates the stable non-executing check path. A separate 230-case legacy suite
evaluates the older SQLite runtime inspection path. The repository also
contains a packaged-install validation script. Benchmarks measure behavior
against their own expected decisions; they are not proof that every dangerous
command form is recognized.

## Current Architectural Reality

Two generations of local state and policy coexist:

| Surface | Policy | Logs | Memory |
| --- | --- | --- | --- |
| `check`, `policy`, `logs`, `memory` | built-in/global/local YAML | `.termyte/logs.jsonl` | `.termyte/memory.jsonl` |
| `run --`, top-level agent commands, `run <agent>`, `allow-once`, `inspect`, `shell`, shims/hooks | SQLite `policy_state` semantic lists | SQLite `ledger` | SQLite `memory_entries` |
| `mcp serve`, `mcp install`, `prove-runtime` | MCP tool dispatch and runtime proof | SQLite `ledger` / proof records | SQLite `memory_entries` |

These paths share the parser, target resolver, and risk engine, but their policy
and memory semantics are different. This distinction matters when interpreting
commands and output.

## Security and Trust Boundary

Termyte governs only actions that enter a Termyte evaluation or interception
surface. It is not a sandbox, an operating-system security boundary, or a
complete process monitor. Absolute executable paths, direct system calls,
unshimmed tools, unsupported shells, or processes that do not inherit the
governed environment can bypass interception.

Termyte redacts recognized secret values before persistence and stores
environment variable keys rather than values. Redaction is pattern-based and
cannot guarantee that every possible secret representation is removed.

## Why Each Major Capability Is Needed

| Capability | Why it is needed |
| --- | --- |
| Parser | Converts command text into stable semantic meaning that policy can match. |
| Target resolver | Determines what a filesystem command can affect and whether targets are protected or outside the workspace. |
| Risk engine | Produces a deterministic baseline decision before user policy. |
| Policy engine | Lets users and repositories express stricter local requirements. |
| Approval layer | Adds a human gate for actions that are risky but not always wrong. |
| Logs and ledger | Provide inspectable evidence and execution outcomes. |
| Operational memory | Retains user feedback and repeated-action context locally. |
| Governed shell | Attempts to intercept subprocess commands before they execute. |
| Doctor | Proves whether the local runtime pieces actually work on the current machine. |
| Benchmarks and package validation | Detect classification regressions and packaging failures. |

## Explicitly Out of Scope

The current repository does not implement cloud sync, a dashboard, an SDK,
multi-tenant authentication, billing, hosted policy management, browser-agent
governance, robotics, or generic APIs.
