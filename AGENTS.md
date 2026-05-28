# Termyte Build Instructions

Termyte is a local-first runtime safety and operational memory layer for AI coding agents.

## Build target
Build v0.1 only. Do not build cloud, dashboard, SDK, enterprise auth, or hosted services.

## Core flow
Agent action → Termyte runtime → parse action → resolve targets → analyze blast radius → check policy → check memory → allow/warn/block → execute if safe → write ledger → update memory.

## Tech stack
- Node.js
- TypeScript
- SQLite
- MCP server wrapper
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

## v0.1 commands
- termyte run -- <command>
- termyte logs
- termyte replay
- termyte memory
- termyte policies

## Out of scope
- SDK
- cloud sync
- dashboard
- multi-tenant auth
- billing
- browser agents
- robotics
- generic APIs
