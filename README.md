# Termyte

Termyte is a local-first safety runtime for AI coding agents.

The current alpha focuses on a direct command gate, a governed MCP gateway,
native Claude Code/Codex hook adapters, SQLite policy/ledger/memory, and
repo-scoped auditability for autonomous coding-agent work. The goal is safer
autonomous execution without moving policy, logs, or memory to a cloud service.

**Alpha:** `termyte run -- <command>` and `termyte mcp serve` are the primary
governed surfaces. Native Claude Code/Codex hooks are public verification
surfaces that validate native agent actions. MCP validates Termyte-owned tools.

## Install

```bash
npm install -g termyte
```

Termyte requires Node.js 20 or later. It does not require signup, a cloud
service, or initialization before use.

## Quickstart

Run these commands inside a repository:

```bash
npm install -g termyte
termyte prove-runtime
termyte mcp install codex
termyte hooks doctor
termyte hooks smoke claude
termyte hooks smoke codex
termyte run -- "git status --short --branch"
termyte check "cat .env"
termyte inspect "git push --force origin main"
termyte allow-once "npm install zod"
termyte mark-safe "npm run build"
termyte policy local add "Ask before touching auth or payments" --dry-run
termyte policy local add "Ask before touching auth or payments" --yes
termyte logs
termyte memory
termyte doctor
```

What happens:

- `check "cat .env"` returns allow/warn/block JSON and records the decision in
  the SQLite ledger.
- `prove-runtime` runs a local proof: allowed read, blocked force push,
  blocked recursive delete, sentinel side-effect check, secret-read warning,
  and replay ledger verification.
- `mcp install codex` prints a stdio MCP configuration for Termyte's governed
  tool gateway for Termyte-owned tools.
- `hooks doctor` and `hooks smoke <agent>` verify native Claude Code/Codex hook
  readiness and live behavior.
- `run -- "<command>"` evaluates policy, logs the pending action, executes
  only if allowed, finalizes the ledger, and updates memory.
- `inspect "<command>"` explains the decision without executing anything.
- `allow-once "<command>"` stores a repo-scoped one-time approval in
  `.termyte/approvals.json`.
- `mark-safe "<command>"` stores a repo-scoped safe memory that can reduce
  repeated warnings without weakening hard blocks.
- The policy dry run prints deterministic generated YAML and writes nothing.
- The policy command with `--yes` creates or updates `termyte.policy.yaml`.
- `logs` shows the SQLite replay ledger.
- `memory` shows the SQLite semantic memory store.
- `doctor` reports local setup and experimental runtime readiness.

## MCP Gateway

Termyte exposes a local stdio MCP server for coding agents that support MCP:

```bash
termyte mcp serve
termyte mcp install codex
termyte mcp install claude
termyte mcp install cursor
termyte mcp install codex --json
```

The MCP server exposes governed tools for Git, filesystem, shell, package
manager, policy explanation, replay, and runtime proof:

```text
termyte.git.status
termyte.git.diff
termyte.git.commit
termyte.git.push
termyte.git.reset
termyte.fs.read
termyte.fs.write
termyte.fs.delete
termyte.shell.run
termyte.package.install
termyte.package.run
termyte.policy.explain
termyte.replay.query
termyte.runtime.prove
```

Each tool call goes through Termyte's parser, target resolver, blast-radius
analysis, policy engine, memory engine, execution gate, replay ledger, and
memory observation. Ordinary workspace file writes are allowed so agents can
edit code. Sensitive/config writes warn, protected or out-of-workspace writes
block, and broad destructive deletes block.

Allowed actions are not a containment boundary. Termyte does not guarantee
that subprocesses spawned inside an allowed command are fully contained unless
future sandbox mode is enabled.

`mcp install` prints a config snippet with `TERMYTE_WORKSPACE` pinned to the
current repository, so the MCP server keeps evaluating actions against the repo
where setup was run even if the agent launches the server from another working
directory.

## Native Hook Verification

Claude Code and Codex native hooks are installed as thin adapters over the
shared runtime evaluator. They validate native agent actions before tool
execution, log pre- and post-tool outcomes, and update memory. They do not go
through MCP.

```bash
termyte hooks doctor
termyte hooks smoke claude
termyte hooks smoke codex
termyte install claude
termyte install codex
```

Codex native hooks are only considered active after a live smoke verification
passes. If native Codex hooks are unavailable, Termyte MCP and Codex
sandbox/approval mode remain available.

## Runtime Proof

`termyte prove-runtime` is the launch readiness proof. It creates a sentinel
under `.termyte/runtime-proof`, runs a safe read, attempts a protected force
push, attempts a recursive force delete, verifies the sentinel still exists,
checks that a secret-looking read requires approval, and verifies the replay
ledger contains the proof decisions.

```bash
termyte prove-runtime
termyte prove-runtime --json
```

Expected healthy output has zero failures and an explicit boundary warning for
raw agent-native tools and unsupported subprocess paths. Allowed commands may
still spawn subprocesses; Termyte does not claim full containment yet.

## Safe Demo

The [repeatable demo guide](https://github.com/termyte-labs/termyte/blob/main/docs/demo.md)
uses a temporary directory and never executes the dangerous-looking command
examples. It demonstrates command checks, policy creation, logs, memory, and
doctor.

## Governance Benchmark

Termyte is evaluated against a deterministic 1,200-action governance suite
spanning safe, review-required, and blocked command text. The benchmark uses
the stable non-executing policy/check path and reports decision precision,
recall, a confusion matrix, false-safe rate, and overblock rate.

```bash
termyte bench
termyte bench --json
termyte bench --legacy
```

The benchmark validates labeled fixtures; it does not prove complete command
coverage or sandbox isolation. See the
[benchmark methodology](https://github.com/termyte-labs/termyte/blob/main/docs/benchmark.md).

## Check Commands Without Executing Them

```bash
termyte check "cat .env"
termyte check "git push --force origin main"
termyte check "npm publish"
termyte check "npm test"
termyte check "npm publish" --json
```

`termyte check` parses, evaluates, and records the supplied command text
without executing it. The command always prints JSON. A blocked check exits
non-zero.

Built-in defaults currently block known secret access, destructive filesystem
operations, protected-branch force pushes, and destructive SQL. Package
installs, package publishing, and other risky operations may warn.

The runtime memory store is semantic and SQLite-backed. It never downgrades a
policy block.

## Policies

Termyte works with built-in defaults when no policy files exist.

```bash
termyte policy presets
termyte policy show
termyte policy show --json
termyte policy test "cat .env"
```

`policy test` evaluates command text without executing it and does not write a
ledger row.

Policy layers:

1. Built-in defaults
2. Global policy at `~/.termyte/policy.yaml`
3. Local policy at `termyte.policy.yaml`

Rules from all loaded layers are evaluated together. Local and global rules
cannot weaken a safer built-in result. When multiple matching rules conflict,
the safest decision wins:

```text
block > ask > warn > allow
```

Run `termyte policy presets` to see the preset names available in this alpha.

Policy files use YAML:

```yaml
version: 1
presets: []
rules:
  - name: ask-auth-changes
    description: Ask before touching auth
    action: ask
    match:
      paths:
        - "src/auth/**"
```

Current matchers are `semantic_ids`, `commands`, and `paths`.

## Natural-Language Policies

Termyte includes a deterministic, local-only compiler for a narrow set of
plain-English policy patterns. It does not call an LLM or external API. This is
policy authoring, not the runtime execution path.

```bash
termyte policy local add "Ask before touching auth or payments" --dry-run
termyte policy local add "Ask before touching auth or payments" --yes
termyte policy global add "Never allow agents to read .env files" --yes
```

- Generated YAML is shown before saving.
- Interactive use asks for confirmation.
- `--dry-run` prints the rule and writes nothing.
- `--yes` or `-y` saves without prompting.
- Unsupported or ambiguous input fails without changing policy files.

Supported alpha pattern families:

- Secret access
- Force push
- Auth and payment paths
- Test deletion
- Package publishing
- Infrastructure and deployment paths
- Destructive database commands

This is template-based policy creation, not free-form language understanding.

## Logs And Memory

```bash
termyte logs
termyte logs --json
termyte memory
```

`check`, `run --`, and governed MCP tool calls all write to the SQLite ledger.
`memory` shows the semantic memory rows derived from runtime observations.
Policy-only commands such as `policy test` remain non-executing and do not
write ledger rows.

## Doctor

```bash
termyte doctor
termyte doctor --json
```

Doctor checks system tools, workspace state, policy/database health,
experimental runtime readiness, optional agent executables, and packaged
assets. Missing optional tools may appear as warnings.

Doctor includes environment-dependent process and runtime checks, so it may
take longer than pure `check` or `policy` commands. A successful doctor report
does not mean Termyte is a sandbox or can observe every execution path.

## Direct Agent Runner

Termyte can launch supported coding agents directly:

```bash
termyte install codex
termyte install claude

termyte codex
termyte claude

termyte run codex
termyte run claude
termyte run claudecode
```

`termyte run <agent>` resolves and launches the agent executable directly. It
does not depend on PATH interception or hook injection. Use `termyte install`
and `termyte uninstall` only if you want the optional native Claude Code/Codex
hook adapters. Those adapters are not required for the default runtime path.

`termyte run -- <command>` is the enforced command gate. It evaluates policy,
writes the ledger, updates memory, and either executes or blocks the command.

## Threat Model

Termyte reduces accidental damage by inspecting known command patterns,
applying local policies, recording decisions, and remembering user-marked
unsafe actions. It does not make agents safe.

### Termyte Protects Against

- Accidental dangerous shell commands
- Obvious destructive file operations
- Secret and config access
- Git history rewrite commands
- Package publishing mistakes
- Destructive database commands
- Repeated unsafe actions through local memory

Protection is strongest when command text is evaluated through `termyte check`,
`termyte run -- <command>`, or governed MCP tools.

### Termyte Does Not Protect Against

- Malicious root-level attackers
- Commands bypassing Termyte
- Arbitrary malware
- Kernel-level attacks
- All shell obfuscation
- Full sandbox isolation
- All direct API calls outside monitored surfaces

## Alpha Limitations

- `termyte run <agent>` is a direct launcher, not a policy gate.
- Commands that bypass Termyte are not governed.
- Direct API calls outside monitored surfaces are not governed.
- The natural-language compiler supports only deterministic templates and is
  part of policy authoring, not the runtime execution path.
- YAML policy matching currently supports `semantic_ids`, `commands`, and
  `paths`.
- Current built-in preset names are an alpha set and may change before a stable
  policy schema release.
- Broader PRD commands such as `explain`, optional `init`, and policy
  use/edit/reset are not documented alpha surfaces yet.
- Cross-platform runtime behavior must be verified with `termyte doctor`.

## Development And Release Verification

```bash
npm run build
npx vitest run --fileParallelism false
npm run validate:package
```

`validate:package` builds, packs, installs into an isolated npm prefix, and
exercises the installed CLI. Doctor results still depend on the local machine
and installed optional tools.

See [CHANGELOG.md](https://github.com/termyte-labs/termyte/blob/main/CHANGELOG.md)
for current alpha release notes.

## Security And Privacy

- Local-first
- No cloud dependency
- No LLM or external API in deterministic natural-language policy compilation
- Policy files, logs, and semantic memory remain on the local machine
- Termyte is a guardrail, not a sandbox

## License

MIT
