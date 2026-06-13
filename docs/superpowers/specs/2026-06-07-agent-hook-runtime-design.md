# Termyte Agent Hook Runtime Design

Date: 2026-06-07

## Purpose

Termyte is shifting from a command checker plus experimental runtime into a local-first safety runtime for autonomous coding agents. The first production-quality step is native tool-call governance for terminal coding agents where the agent platform exposes hooks.

This design targets Claude Code and Codex only. Aider is intentionally out of scope for this slice because its public docs do not expose a native pre-tool interception API comparable to Claude Code or Codex hooks.

## Product Claim

Termyte makes autonomous Claude Code and Codex sessions safer by enforcing local policy, operational memory, and replay logging at supported tool boundaries before actions execute.

Termyte is not an OS sandbox in this slice. It governs supported agent sessions through native hooks and direct runtime enforcement. Unmanaged agent launches remain outside Termyte's local enforcement boundary unless teams add endpoint, managed settings, CI, or policy controls.

## Goals

- Make setup low-friction: one Termyte command should install or print the needed agent integration.
- Govern Claude Code and Codex native tool calls before execution.
- Reuse the existing parser, resolver, blast-radius analyzer, policy engine, memory engine, approval layer, and replay ledger.
- Fail closed when a hook event cannot be parsed, policy cannot be evaluated, or the Termyte hook command cannot reach its runtime state.
- Record every hook decision in the SQLite ledger.
- Call memory observation for every finalized action result.
- Clearly report when the current session is not fully governed.

## Non-Goals

- Aider native integration.
- Cloud sync, hosted policy, SDKs, identity management, enterprise auth, billing, or dashboard features.
- OS-level process containment, syscall interception, ptrace, seccomp, or kernel sandboxing.
- Replacing Claude Code or Codex built-in permission systems.
- Blocking a user who intentionally launches an unmanaged agent outside Termyte.

## Agent Surfaces

### Claude Code

Claude Code supports plugin-bundled hooks and settings-defined hooks. The relevant event is `PreToolUse`, which fires after Claude creates tool parameters and before the tool call is processed. The hook receives JSON on stdin and can allow, deny, ask, or defer the tool call.

Termyte will provide:

- `termyte install claude`
- `termyte agent hook claude`
- `termyte agent hook claude --post`
- `termyte run claude`

The install command should prefer a Claude plugin or generated hook configuration that registers Termyte for:

- `PreToolUse` for `Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `Agent`, `WebFetch`, `WebSearch`, and MCP tool names.
- `PostToolUse` for the same supported tool family where result observation is possible.

### Codex

Codex supports hooks via `hooks.json`, inline `[hooks]` config, and plugin-bundled lifecycle config. The relevant events are `PreToolUse`, `PermissionRequest`, and `PostToolUse`. Matchers can target `Bash`, `apply_patch`, `Edit`, `Write`, and MCP tool names.

Termyte will provide:

- `termyte install codex`
- `termyte agent hook codex`
- `termyte agent hook codex --post`
- `termyte run codex`

The install command should generate a Codex plugin or hooks config that routes native tool events to Termyte.

## UX

### Setup

The low-friction path should be:

```bash
termyte install claude
termyte run claude
```

and:

```bash
termyte install codex
termyte run codex
```

`termyte install <agent>` should be safe to rerun. It should either install/update the integration or print exact manual steps when automatic writes are not safe.

### Verification

`termyte run <agent>` should verify the relevant hook integration before launching the agent. If verification fails, it should explain the issue and provide a command to fix it.

Initial policy:

- Missing hooks: fail closed for Claude/Codex native-hook profiles.
- Disabled hooks: fail closed when detectable.
- Unknown hook state: warn or fail depending on profile. Default should favor fail closed for the native-hook runtime.

### Runtime

During launch, Termyte sets:

```text
TERMYTE_RUN=1
TERMYTE_SESSION_ID=<local session id>
TERMYTE_AGENT=<claude|codex>
TERMYTE_WORKSPACE=<absolute workspace root>
```

The agent launches as a normal child process. Native hooks call Termyte before tool execution.

## Hook Normalization

Add a module that maps agent-native hook events to Termyte actions.

For Claude:

- `Bash` maps `tool_input.command` to a shell action.
- `Write` maps path and content metadata to a file write action.
- `Edit` maps path and edit metadata to a file edit action.
- `Read`, `Glob`, and `Grep` map to read/query actions.
- MCP tool names map to MCP action records with the tool name and arguments.

For Codex:

- `Bash` maps command input to a shell action.
- `apply_patch`, `Edit`, and `Write` map to file mutation actions.
- MCP tool names map to MCP action records.
- `PermissionRequest` maps to the same policy check path but may return a prompt/approval decision instead of a direct allow.

The normalized action must include:

- agent name
- event name
- tool name
- command or target path when available
- cwd
- session id
- raw hook payload hash
- redacted metadata

Do not store secret values. Environment variables must be logged by key only.

## Decision Flow

`termyte agent hook <agent>` should:

1. Read JSON from stdin.
2. Validate the event shape.
3. Normalize the event into a Termyte action.
4. Resolve targets.
5. Analyze blast radius.
6. Evaluate policy.
7. Check memory.
8. Write a pending ledger record.
9. Return the agent-specific allow, deny, ask, or defer response.

For blocked pre-tool events, finalize the ledger immediately with a blocked outcome and call memory observation.

For allowed pre-tool events, write a pending record and include a correlation id in the hook response or a local side channel where the platform supports it. If correlation cannot be passed through the agent, finalize the pre-tool record as an allow decision with `outcome.status = "delegated"` and use `PostToolUse` to write a separate observation record.

## Failure Behavior

Termyte must fail closed for:

- invalid hook JSON
- unknown agent hook format
- missing workspace root
- unavailable policy database
- unavailable ledger database
- parser or resolver exceptions

Termyte may allow with warning only for known low-risk observation gaps, such as a post-tool event that cannot be correlated to a pre-tool event after the pre-tool action was already permitted.

## Existing Code Reuse

Use the current modules where possible:

- `parser.ts` for command parsing
- `resolver.ts` for target resolution
- `risk.ts` for blast radius
- `policy-loader.ts`, `policy-merge.ts`, and `policy-evaluator.ts` for local policy
- `memory.ts` and `local-memory.ts` for operational memory
- `ledger.ts` for replay
- `mcp.ts` for governed MCP tools

Avoid duplicating policy engines for hooks. Hooks should be another front door into the same runtime decision pipeline.

## Implementation Stages

### Stage 1: Claude Native Hook Bridge

- Add `termyte agent hook claude`.
- Support `PreToolUse` for `Bash`, `Write`, `Edit`, and `Read`.
- Return correct Claude decision JSON.
- Write ledger records for allow and block.
- Add tests with representative Claude hook payloads.

### Stage 2: Claude Install and Run Verification

- Add `termyte install claude`.
- Generate the Claude hook/plugin configuration.
- Make `termyte run claude` verify hook presence before launch.
- Add a doctor check for Claude hook readiness.

### Stage 3: Codex Native Hook Bridge

- Add `termyte agent hook codex`.
- Support `PreToolUse`, `PermissionRequest`, and `PostToolUse` for `Bash`, `apply_patch`, `Edit`, `Write`, and MCP tools.
- Return correct Codex hook responses.
- Add tests with representative Codex hook payloads.

### Stage 4: Codex Install and Run Verification

- Add `termyte install codex`.
- Generate Codex hook config or plugin lifecycle config.
- Make `termyte run codex` verify hook presence before launch.
- Add a doctor check for Codex hook readiness.

### Stage 5: Runtime Proof Expansion

- Extend `termyte prove-runtime --json` to report native hook readiness separately from MCP readiness.
- Add proof cases for blocked shell commands through hook payload simulation.
- Keep bypassability explicit in the proof report.

## Testing

Required tests:

- Claude `Bash("rm -rf ...")` returns deny and writes ledger.
- Claude safe read command returns allow and writes ledger.
- Claude `Write` to `.env` returns deny.
- Codex `Bash("git push --force ...")` returns deny or ask based on policy.
- Codex `apply_patch` touching normal workspace files returns allow.
- Invalid hook payload fails closed.
- Missing session env fails closed.
- Install commands are idempotent.
- Run verification detects missing hook config.

Required validation:

```bash
npm run build
npm test
npm run validate:package
```

## Onboarding Standard

The first-run experience must be understandable without reading docs:

```bash
termyte install claude
termyte doctor
termyte run claude
```

If something is missing, the CLI must name the exact missing layer:

- agent executable not found
- hook config missing
- hook config disabled
- plugin installed but not trusted
- policy database unavailable
- ledger database unavailable

The output should never imply full OS containment. It should say native tool calls are governed when the hook layer is active.
