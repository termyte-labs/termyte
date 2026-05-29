# Termyte

Termyte is a local-first runtime safety layer for AI coding agents. It sits between an agent and the shell, normalizes the action semantically, resolves targets, scores blast radius, checks policy and memory, then decides whether to `allow`, `warn`, or `block`.

> Benchmark: 230 dangerous/safe agent actions, 100% accuracy, 0 false negatives, 0 false positives.

## Install

```bash
npm install -g termyte
```

## Governed Shell

Use `termyte shell` when you want Termyte to own the session and intercept child commands automatically.

```bash
termyte shell
termyte shell -- codex
termyte shell -- claude
termyte shell -- aider
```

The shell runtime is local-first and works on macOS, Linux, and Windows. It prepends Termyte shims to `PATH`, exports session metadata, and keeps subprocesses inside the governed session.

## 30-Second Demo

```bash
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

- `termyte run -- <command>`: guard and optionally execute a command
- `termyte inspect -- <command>`: show parsing, targets, risk, memory, and final decision
- `termyte logs`: show the recent ledger
- `termyte replay`: show an incident timeline
- `termyte memory`: list operational memories
- `termyte bench`: run the benchmark suite
- `termyte allow-once -- <command>`: run a warned command once
- `termyte mark-safe <memory-id>`: downgrade a memory after a false positive
- `termyte policies`: print active policy rules
- `termyte shell [-- <agent>]`: start a governed session and launch an optional agent inside it

## Examples

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

## Launch Notes

- Current benchmark: 230 cases
- Current benchmark accuracy: 100%
- False negatives: 0
- False positives: 0
- Architecture is intentionally frozen for v0.1 launch cleanup
