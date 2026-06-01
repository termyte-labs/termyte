# Termyte

Termyte is a local-first runtime safety layer for AI coding agents. It sits between an agent and the shell, normalizes the action semantically, resolves targets, scores blast radius, checks policy and memory, then decides whether to `allow`, `warn`, or `block`.

> Benchmark: 230 dangerous/safe agent actions, 100% accuracy, 0 false negatives, 0 false positives.

## Install

```bash
npm install -g termyte
```

## Agent Runtime

Use `termyte run` when you want to launch an agent inside a governed Termyte session. This is the primary product workflow.

```bash
termyte run codex
termyte run claude
termyte run aider
termyte run --dry-run codex
termyte run --profile codex-windows codex
```

Supported agent names:

- `codex`
- `claude`
- `aider`

Supported runtime profiles:

- `default`
- `codex-windows`
- `codex-unix`
- `claude-windows`
- `claude-unix`
- `aider`

`termyte run --dry-run <agent>` shows the resolved executable, args, selected profile, platform, enabled shims, disabled shims, shell-hook state, known limitations, workspace root, and database path.

If you need generic command support, use `termyte run -- <command>` or `termyte shell -- <command>`.

## Governed Shell

Use `termyte shell` when you need the lower-level governed session primitive directly. This runtime is alpha: it is useful for debugging and for generic command coverage, but it is not an OS sandbox.

```bash
termyte shell
termyte shell -- node --version
termyte shell -- codex
termyte shell -- claude
termyte shell -- aider
```

The shell runtime is local-first and works on macOS, Linux, and Windows. It prepends Termyte shims to `PATH`, exports session metadata, and keeps subprocesses inside the governed session. Interactive shell hooks currently cover bash, zsh, and PowerShell; subprocess interception is handled by PATH shims. `termyte run` uses this same runtime internally and adds agent metadata, runtime profiles, and launch logging.

## 30-Second Demo

```bash
termyte run codex
termyte run --dry-run claude
termyte inspect -- "rm -rf *"
termyte inspect -- "powershell Remove-Item -Recurse -Force *"
termyte run -- rm -rf *
termyte bench
termyte logs
termyte replay
```

## What It Does

Termyte turns raw commands into semantic actions before execution.

Example:

```txt
rm -rf *
==
Remove-Item -Recurse -Force *
```

Both normalize to the same destructive filesystem action. That matters because risk should follow meaning, not shell syntax.

## Runtime Flow

```text
agent action
  -> Termyte runtime
  -> parse command
  -> resolve targets
  -> analyze blast radius
  -> evaluate policy
  -> check operational memory
  -> allow / warn / block
  -> execute if safe
  -> write ledger
  -> update memory
```

## What Gets Blocked Or Warned

- Recursive or wildcard filesystem deletes
- Deletion of `.git`, `.github`, home, or root paths
- Force pushes to protected branches
- Package publishing
- SQL destructive operations
- Remote script execution and permission escalation are covered in the benchmark suite

## Storage And State

- SQLite database: `.termyte/termyte.db`
- Override path with `TERMYTE_DB_PATH`
- Logs, replay, and memory all read from the same local SQLite state
- Secrets are redacted before persistence

## Safety Overrides

- `termyte allow-once -- <command>` allows one warned action through
- `termyte mark-safe <memory-id>` marks a memory as safe and lowers its confidence
- Hard-critical destructive deletes on root, home, or `.git` still stay blocked

## Benchmark Coverage

The benchmark suite currently covers:

- filesystem deletion
- git destructive operations
- package publishing
- secret access
- remote script execution
- permission escalation
- SQL destructive operations

Run it with:

```bash
termyte bench
```

## Command Reference

- `termyte run <agent> [...args]`: launch a supported agent in a governed runtime
- `termyte run --dry-run <agent> [...args]`: print the selected profile and resolved runtime plan without launching the agent
- `termyte run --profile <profile> <agent> [...args]`: launch an agent with an explicit runtime profile
- `termyte run -- <command>`: guard and optionally execute a generic command
- `termyte inspect -- <command>`: show parsing, targets, risk, memory, and final decision
- `termyte logs`: show the recent ledger
- `termyte replay`: show an incident timeline
- `termyte memory`: list operational memories
- `termyte bench`: run the benchmark suite
- `termyte allow-once -- <command>`: run a warned command once
- `termyte mark-safe <memory-id>`: downgrade a memory after a false positive
- `termyte policies`: print active policy rules
- `termyte shell [-- <agent>]`: start the lower-level governed session and launch an optional command or agent inside it

## Examples

Run Codex in a governed session:

```bash
termyte run codex
```

Run Claude in dry-run mode:

```bash
termyte run --dry-run claude
```

Inspect a dangerous delete:

```bash
termyte inspect -- "rm -rf *"
```

Inspect a PowerShell delete:

```bash
termyte inspect -- "powershell Remove-Item -Recurse -Force *"
```

Run through the runtime:

```bash
termyte run -- rm -rf *
```

View recent events:

```bash
termyte logs
termyte replay
```

## Security And Privacy

- Local-first only
- SQLite only
- No cloud dependency
- No remote execution service
- Secrets are redacted before ledger persistence
- `termyte run` and `termyte shell` are not OS sandboxes; absolute paths, direct syscalls, or processes that do not inherit the governed environment can bypass the alpha runtime boundary

## FAQ

### Why not just regex rules?

Regexes miss equivalent actions across shells. Termyte normalizes semantics first, then applies risk rules.

### Why not rely only on LLMs?

Safety decisions should not depend on probabilistic output. Termyte uses deterministic parsing, target resolution, and policy checks.

### Does this execute commands remotely?

No. Execution is local through the host shell.

### Does this send data to a server?

No. The runtime is local-first and uses SQLite on disk.

### What happens on unknown dangerous actions?

Termyte fails closed when it cannot safely evaluate the risk.

## Troubleshooting

- PowerShell commands require `powershell.exe` or `pwsh` on the host
- The SQLite database defaults to `.termyte/termyte.db` under the current workspace
- If the workspace is not writable, set `TERMYTE_DB_PATH` to a writable location
- If global install cannot find `termyte`, make sure your npm global bin directory is on `PATH`
- If `termyte --help` does not run, use `termyte -h` or `termyte` with no args
- If `termyte run codex` disables shell-host shims on Windows, that is expected for the `codex-windows` profile

## Launch Notes

- Current benchmark: 230 cases
- Current benchmark accuracy: 100%
- False negatives: 0
- False positives: 0
- Governance core is intentionally frozen for launch cleanup
- `termyte run` is the primary agent UX
- `termyte shell` remains the lower-level runtime primitive
- Shell-owned runtime is alpha and should be treated as a guardrail, not a sandbox
