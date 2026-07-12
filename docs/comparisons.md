# Comparisons

This page compares Termyte with mem0, agentmemory, and claude-mem using the code and docs in the local repositories.

## Short Version

- Termyte is the most local-first and SQLite-centered of the four, with an experience-layer focus.
- mem0 is the broadest memory platform, with managed and self-hosted modes.
- agentmemory is a larger OSS memory engine with a wider integration and benchmark surface.
- claude-mem is the most Claude Code-oriented and workflow-heavy.

## Comparison Table

| Product | Core shape | Strength | Tradeoff |
|---|---|---|---|
| Termyte | Local experience layer for coding agents | Durable capture, episode evidence, provenance, retrieval, and operator visibility in one small runtime | Narrower scope and smaller surface area |
| mem0 | Memory platform and OSS memory layer for agents | Broad SDK/platform coverage, many integrations, managed and self-hosted options | Less focused on a local repo-centered workflow |
| agentmemory | OSS memory engine with hooks, MCP, viewer, benchmarks, and many integrations | Very broad agent ecosystem coverage and extensive docs/benchmarks | Larger, more opinionated stack with more moving parts |
| claude-mem | Claude Code-first persistent memory system | Deep Claude Code integration, hook-centric workflow, and rich docs | More Claude-specific and heavier on workflow conventions |

## What Termyte Chooses

Termyte is not trying to be the biggest memory platform.
It is trying to be the clearest local experience layer for coding agents:

- traces first
- episodes and evidence next
- durable queue second
- reusable memories after that
- retrieval and compact context cards after that
- feedback and explainability always attached

## What The Others Emphasize

- mem0 emphasizes platform breadth, API shape, and multiple deployment modes.
- agentmemory emphasizes a large memory engine with many agents, plugins, and public benchmarks.
- claude-mem emphasizes Claude Code workflows, hooks, and a broader system around persistent session memory.

## Bottom Line

If you want a compact, local, inspectable experience layer that stays close to one repo and one SQLite database, Termyte is the sharper fit.
If you want a broader platform, larger integration surface, or a more opinionated agent ecosystem, the others push harder in that direction.
