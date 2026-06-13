# Codex Integration

Termyte integrates with Codex through native lifecycle hooks and MCP.

```bash
termyte install codex
termyte hooks smoke codex
termyte run codex
termyte mcp install codex
```

`termyte install codex` writes repo-local `.codex/hooks.json` entries for
`PreToolUse`, `PermissionRequest`, and `PostToolUse`. Existing config is backed
up before Termyte writes a changed file. The hook command points to the built
Termyte CLI through the current Node executable.

Codex `PreToolUse` can deny supported tool calls using hook JSON. Codex hook
coverage is not a complete enforcement boundary: unsupported tool paths,
commands that bypass hooks, and commands outside Termyte-owned MCP tools are not
guaranteed to be intercepted.

Codex requires non-managed command hooks to be reviewed and trusted before they
run. After installing Termyte hooks, open `/hooks` inside Codex, review the
repo-local Termyte hook definitions, and trust the current hook hash. For
one-off automation, Codex also supports `--dangerously-bypass-hook-trust`.

For stronger Termyte-owned command governance, use `termyte run -- <command>` or
the MCP gateway.
