# Termyte Public Docs

Termyte is a local execution and continuity layer for coding agents.

This folder is the public-facing docs set. It explains what Termyte does today, how to use its capture-to-experience path, what it does not do yet, and how it compares with mem0, agentmemory, and claude-mem.

## Start Here

- [Getting Started](getting-started.md)
- [How It Works](how-it-works.md)
- [Comparisons](comparisons.md)
- [Limitations](limitations.md)
- [LLM Index](../llms.txt)

## What Termyte Is

Termyte is a local-first system that:

- captures Claude Code, Codex, and OpenCode activity in a replay-safe event ledger
- projects prompts, tool calls, commands, and file changes deterministically
- maintains authoritative requirements, steps, decisions, failures, and verification evidence
- creates Git-aware checkpoints, resume packets, and cross-agent handoffs
- groups coding work into episodes with observable evidence
- derives observations and memories from those traces
- retrieves relevant experience as compact context cards with explicit detail lookup
- keeps provenance, feedback, and lifecycle state attached to the data

## What To Expect

Termyte is useful today for local, inspectable coding experience.
It does not claim comprehensive privacy, causal outcome attribution, or proven real-world agent improvement.
