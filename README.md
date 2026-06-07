# Termyte

Termyte is a local-first safety runtime for AI coding agents.

The current alpha focuses on a Termyte-controlled tool gateway, risky command
checks, local policies, replayable decisions, and repo-scoped safety memory.
The goal is safer autonomous coding-agent work without moving policy or logs to
a cloud service.

**Alpha:** MCP/runtime tool calls are governed. Raw agent-native tools, direct
syscalls, absolute executable paths, and unsupported subprocess paths still
require hooks or sandboxing. `termyte run <agent>` remains experimental
interception, not sandbox containment.

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
termyte check "cat .env"
termyte policy local add "Ask before touching auth or payments" --dry-run
termyte policy local add "Ask before touching auth or payments" --yes
termyte logs
termyte memory
termyte doctor
```

What happens:

- `check "cat .env"` returns a block decision without executing `cat`.
- `prove-runtime` runs a local proof: allowed read, blocked force push,
  blocked recursive delete, sentinel side-effect check, secret-read warning,
  and replay ledger verification.
- `mcp install codex` prints a stdio MCP configuration for Termyte's governed
  tool gateway.
- The policy dry run prints deterministic generated YAML and writes nothing.
- The policy command with `--yes` creates or updates `termyte.policy.yaml`.
- `logs` shows decisions written by `check`.
- `memory` shows commands explicitly marked safe or unsafe.
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

`mcp install` prints a config snippet with `TERMYTE_WORKSPACE` pinned to the
current repository, so the MCP server keeps evaluating actions against the repo
where setup was run even if the agent launches the server from another working
directory.

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
raw agent-native tools and unsupported subprocess paths.

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

`termyte check` parses and evaluates the supplied command text but does not
execute it. A blocked check exits non-zero. Each check writes a local log event.

Built-in defaults currently block known secret access, destructive filesystem
operations, protected-branch force pushes, and destructive SQL. Package
publishing and other risky operations may warn.

Memory is evaluated after policy. Unsafe memory can upgrade an otherwise
allowed command to a warning, but safe or unsafe memory cannot weaken a policy
block.

## Policies

Termyte works with built-in defaults when no policy files exist.

```bash
termyte policy presets
termyte policy show
termyte policy show --json
termyte policy test "cat .env"
```

`policy test` evaluates command text without executing it and does not write a
log event.

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
plain-English policy patterns. It does not call an LLM or external API.

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
termyte logs --blocked
termyte logs --warned
termyte logs --agent codex
termyte logs --today
termyte logs --json

termyte mark-safe "npm test"
termyte mark-unsafe "npm publish"
termyte memory
```

The stable alpha check flow stores repo-local state in:

```text
.termyte/logs.jsonl
.termyte/memory.jsonl
```

`check` writes logs. `policy test`, `logs`, and `memory` do not write check log
events. Alpha memory uses exact normalized command matching and is repo-scoped.

Unsafe memory may upgrade `allow` to `warn`. Memory never downgrades `block`,
`ask`, or `warn`.

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

## Governed Agent Runner

Termyte can start supported coding agents inside a governed local session:

```bash
termyte codex
termyte claude
termyte aider

termyte run codex
termyte run claude
termyte run claudecode
termyte run aider
```

The top-level agent commands are aliases for the governed `run` path.

The agent runner starts in `runtime mode: intercepted`. Termyte creates the
same governed session used by `termyte shell`: command shims are prepended to
`PATH`, supported shell hooks are installed, a local guard evaluates intercepted
commands before dispatch, and runtime actions are written to the SQLite ledger.

This is interception, not containment. It is not a full sandbox and may not
observe absolute executable paths, unshimmed tools, direct syscalls, direct API
calls, or processes that do not inherit the governed environment. Use
`termyte doctor` before evaluating runtime coverage on a machine.

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
`termyte policy test`, or an explicitly governed experimental runtime path.

### Termyte Does Not Protect Against

- Malicious root-level attackers
- Commands bypassing Termyte
- Arbitrary malware
- Kernel-level attacks
- All shell obfuscation
- Full sandbox isolation
- All direct API calls outside monitored surfaces

## Alpha Limitations

- Runtime interception is experimental and is not production-grade isolation.
- `termyte run <agent>` governs supported subprocess paths through shims and
  hooks, but it is not full process containment.
- Commands that bypass Termyte are not governed.
- Direct API calls outside monitored surfaces are not governed.
- The natural-language compiler supports only deterministic templates.
- YAML policy matching currently supports `semantic_ids`, `commands`, and
  `paths`.
- Stable alpha check logs and memory are repo-local JSONL files.
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
- Policy files and stable alpha logs/memory remain on the local machine
- Termyte is a guardrail, not a sandbox

## License

MIT
