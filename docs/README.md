# Termyte Documentation

These documents describe the current local CLI/runtime implementation. They are
based on the source code and tests in this repository, not on planned cloud,
dashboard, SDK, or enterprise features.

## Start Here

- [Project description](project-description.md): what Termyte is, why it
  exists, what it currently does, and its limits.
- [Architecture](architecture.md): the compact MVP architecture and runtime
  boundaries.
- [Architecture and runtime logic](architecture-and-runtime-logic.md): how
  commands are parsed, scored, governed, blocked, logged, and remembered.
- [Policies](policies.md): current policy sources, precedence, and examples.
- [Policy modes](policy-modes.md): intended modes and current implementation
  boundary.
- [Approvals](approvals.md): `allow-once`, `mark-safe`, and local memory.
- [Codex integration](codex-integration.md): native hook and MCP behavior.
- [Claude Code integration](claude-integration.md): native hook and MCP
  behavior.
- [Limitations](limitations.md): explicit non-goals and current gaps.
- [Product research](product-research.md): practical market direction.
- [Feature and file reference](feature-and-file-reference.md): every current
  user-facing feature and every source, test, script, and data file.
- [Governance benchmark](benchmark.md): fixture design, metrics, compatibility
  suite, and claim boundaries.
- [Safe alpha demo](demo.md): repeatable commands that demonstrate the stable
  non-executing surfaces.

## Current Product Boundary

Termyte is a local-first Node.js CLI for deterministic command risk analysis,
local policy enforcement, operational records, an MCP gateway, and optional
native hook adapters. It has no cloud dependency and no LLM in its critical
decision path.

The most dependable alpha surfaces are:

- `termyte check`
- `termyte policy`
- `termyte logs`
- `termyte memory`
- `termyte inspect`
- `termyte allow-once`
- `termyte mark-safe`
- `termyte doctor`
- `termyte prove-runtime`
- `termyte mcp serve`
- `termyte mcp install <agent>`

The native hook adapters are optional:

- `termyte install <claude|codex>`
- `termyte codex`, `termyte claude`
- `termyte run <agent>`
- `termyte run -- <command>`

The MCP gateway is the launchable governed path for coding agents that support
MCP. It exposes Termyte-controlled Git, filesystem, package, policy, replay,
and proof tools. `termyte run <agent>` is a direct launcher, not an
interception path.
