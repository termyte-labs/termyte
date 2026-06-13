# Claude Code Integration

Termyte integrates with Claude Code through native hooks and MCP.

```bash
termyte install claude
termyte hooks smoke claude
termyte run claude
termyte mcp install claude
```

`termyte install claude` writes repo-local `.claude/settings.local.json` hook
entries for `PreToolUse` and `PostToolUse`. Existing config is backed up before
Termyte writes a changed file.

Claude Code `PreToolUse` supports pre-tool deny behavior for supported tool
calls. Termyte maps `block` to a deny response, maps warning decisions to an ask
response, and records pre/post outcomes in the local ledger.

Hooks run as the local user and are not a sandbox. Commands that bypass hooks or
run outside monitored tool paths are outside Termyte's guarantee.

