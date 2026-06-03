# Termyte Build Instructions

Termyte is a local-first runtime safety and operational memory layer for AI coding agents.

## Build target
Build the local CLI/runtime only. Do not build cloud, dashboard, SDK, enterprise auth, or hosted services.

## Core flow
Agent action → Termyte runtime → parse action → resolve targets → analyze blast radius → check policy → check memory → allow/warn/block → execute if safe → write ledger → update memory.

## Primary UX
- `termyte run <agent>` is the primary user-facing agent command.
- `termyte shell` is the lower-level governed session primitive.
- `termyte policies` is the local policy editing surface.

## Tech stack
- Node.js
- TypeScript
- SQLite
- No cloud dependency
- No LLM in critical execution path

## Required modules
- Action Parser
- Target Resolver
- Blast Radius Analyzer
- Risk Engine
- Policy Engine
- Memory Engine
- Approval Layer
- Replay Ledger
- CLI

## Safety rules
- Dangerous actions must fail closed.
- Never log secret values.
- Log only environment variable keys, not values.
- Do not execute an action before risk analysis.
- Do not use agent reasoning as a trusted signal.
- Every action must be written to the ledger.
- Every action must call memory.observe(action, result).
- Policy updates must be stored locally in SQLite and loaded by the runtime.

## v0.1 commands
- `termyte run <agent> [...args]`
- `termyte run --dry-run <agent> [...args]`
- `termyte run --profile <profile> <agent> [...args]`
- `termyte run -- <command>`
- `termyte logs`
- `termyte replay`
- `termyte memory`
- `termyte policies`
- `termyte policies add <block|warn> <patterns...>`
- `termyte policies remove <block|warn> <patterns...>`
- `termyte policies set [--block <patterns...>] [--warn <patterns...>]`
- `termyte policies reset`

## Out of scope
- SDK
- cloud sync
- dashboard
- multi-tenant auth
- billing
- browser agents
- robotics
- generic APIs
