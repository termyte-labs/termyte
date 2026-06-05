# Termyte Documentation

These documents describe the current local CLI/runtime implementation. They are
based on the source code and tests in this repository, not on planned cloud,
dashboard, SDK, or enterprise features.

## Start Here

- [Project description](project-description.md): what Termyte is, why it
  exists, what it currently does, and its limits.
- [Architecture and runtime logic](architecture-and-runtime-logic.md): how
  commands are parsed, scored, governed, blocked, logged, and remembered.
- [Feature and file reference](feature-and-file-reference.md): every current
  user-facing feature and every source, test, script, and data file.
- [Governance benchmark](benchmark.md): fixture design, metrics, compatibility
  suite, and claim boundaries.
- [Safe alpha demo](demo.md): repeatable commands that demonstrate the stable
  non-executing surfaces.

## Current Product Boundary

Termyte is a local-first Node.js CLI for deterministic command risk analysis,
local policy enforcement, operational records, and experimental subprocess
governance. It has no cloud dependency and no LLM in its critical decision
path.

The most dependable alpha surfaces are:

- `termyte check`
- `termyte policy`
- `termyte logs`
- `termyte memory`
- `termyte doctor`

The execution and interception surfaces are implemented but experimental:

- `termyte codex`, `termyte claude`, `termyte aider`
- `termyte run <agent>`
- `termyte run -- <command>`
- `termyte shell`
- internal shell hooks and command shims

Top-level agent commands are aliases for the governed `run <agent>` path.
Agent sessions prepare policy, logs, memory, session context, command shims,
shell hooks, and a local guard daemon before launching the agent. This is
governed interception for supported execution paths, not a full sandbox.
