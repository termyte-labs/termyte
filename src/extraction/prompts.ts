export const EXTRACT_MEMORIES_PROMPT = `You are analyzing a coding agent session trace to extract reusable memories.

A "memory" is a durable fact, bugfix pattern, procedure, convention, or warning that would help a coding agent in future sessions.

Repository: {repoScope}

Session trace:
{trace}

Extract ALL applicable memories from this trace. For each memory:
- claim: A clear, self-contained description of the fact/fix/procedure/convention/warning
- type: One of "fact", "bugfix", "procedure", "convention", "warning"
- language: The programming language if applicable (e.g. "typescript", "python")

Focus on:
1. Bug fixes: What went wrong and how it was fixed
2. Facts about the codebase: Architecture, conventions, dependencies
3. Procedures: Multi-step workflows that succeeded
4. Warnings: Patterns that caused problems
5. Conventions: Coding style, naming patterns, project structure

Do NOT include:
- One-off temporary actions with no reusable value
- Trivial observations (e.g. "user typed a command")
- Anything that would become stale quickly

Return structured JSON memories.`;

export const CONSOLIDATE_MEMORIES_PROMPT = `You are consolidating similar coding memories into higher-level patterns.

Given these memory claims:
{claims}

Identify groups of memories that describe the same underlying concept or pattern. For each group, create a single consolidated memory that captures the general principle.

Only consolidate if memories are genuinely related. If a memory is unique, keep it separate.

Return a consolidation result with the merged claims and which original indices they cover.`;

export const RERANK_PROMPT = `You are re-ranking retrieved memories for relevance to a coding task.

Task: {task}

Retrieved memories:
{memories}

For each memory, score its relevance to the task from 0.0 to 1.0.
Consider:
- How directly the memory applies to the current problem
- Whether the memory's type (bugfix, procedure, etc.) is useful here
- The memory's confidence and evidence quality

Return a JSON array of relevance scores in the same order as the input memories.`;
