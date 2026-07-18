# OpenCode Synthesis Adapter

## Goal

Allow OpenCode to serve as Termyte's non-interactive synthesis provider without changing existing Codex, Claude Code, API, or capture-only behavior.

## Design

Add an `OpenCodeAdapter` implementing the existing `AgentAdapter` contract. It will resolve `opencode` from `OPENCODE_PATH` or normal binary discovery and invoke the documented non-interactive command:

```text
opencode run --format json <prompt>
```

The adapter will run in the requested working directory, set `TERMYTE_INTERNAL_SYNTHESIS=1`, support timeout and abort handling, parse raw JSON events for the final text response, and map failures to the existing `AgentInvocationError` reasons. Windows command wrappers will use the same handling as the existing adapters.

OpenCode will be added to the existing adapter ID, factory, discovery, user-configuration, runtime-provider, capability-check, and initialization selection paths. Existing provider ordering and behavior will remain unchanged; OpenCode will be appended as another supported choice.

## Validation

Add one focused adapter test covering invocation arguments, prompt delivery, JSON-event parsing, and failure behavior. Update existing configuration and initialization expectations only where the supported provider union changes. Run the adapter tests, full test suite, typecheck, and build.

## Non-goals

- No persistent `opencode serve` process or attach mode.
- No new synthesis abstraction or dependency.
- No changes to capture, memory prompts, persistence, or retrieval.
