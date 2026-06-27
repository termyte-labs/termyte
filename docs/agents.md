# Agent setup

`termyte install <platform>` is the single command that wires termyte into your agent. It writes the appropriate config file (and backs up any pre-existing one) without touching any of the agent's other settings.

The supported platforms are:

| Platform | `termyte install ...` | Hook capture | Synthesis |
|---|---|---|---|
| Claude Code | `claude-code` | yes | yes |
| Codex (OpenAI) | `codex` | yes | yes |
| OpenCode | `opencode` | yes | yes |
| Cursor | `cursor` | yes | manual |
| Gemini CLI | `gemini-cli` | yes | yes |
| Windsurf | `windsurf` | yes | n/a |
| Copilot CLI | `mcp:copilot-cli` | via MCP | via MCP |
| Antigravity | `mcp:antigravity` | via MCP | via MCP |
| Goose | `mcp:goose` | via MCP | via MCP |
| Roo Code | `mcp:roo-code` | via MCP | via MCP |
| Warp | `mcp:warp` | via MCP | via MCP |

"Hook capture" means termyte receives the agent's per-event JSON payload and writes a trace. "Synthesis" means termyte can borrow the agent's LLM plan to convert traces into memories. Agents that can't drive synthesis (Cursor, Windsurf, and the MCP-only set) are still useful — they capture traces, and you can run `termyte synth --adapter <other>` against a different agent's plan, or skip synthesis and rely on direct FTS5 search over the raw trace text.

By default, the installer writes to the user-level config (`~/.claude/settings.json`, `~/.codex/hooks.json`, etc.). Pass `--target project` to write to the project-level config (`./.claude/settings.json`, `./.codex/hooks.json`) instead.

## Claude Code

```bash
termyte install claude-code
```

Writes to `~/.claude/settings.json` (or `./.claude/settings.json` with `--target project`). Registers hooks for:

| Agent event | termyte handler | Purpose |
|---|---|---|
| `SessionStart` | `session-init` | Upsert the session and inject initial context. |
| `UserPromptSubmit` | `context` | Inject relevant memories for the user's prompt. |
| `PreToolUse` | `file-context` | For `Read` tools, inject memories related to the file path. |
| `PostToolUse` | `observation` | Capture the tool call as a trace. Lean: does not load the embeddings model. |
| `Stop` | `summarize` | Generate the session's markdown summary. |

The installer bakes the absolute path to `termyte-hook` at install time. If you move the binary, re-run the installer.

To uninstall, remove the `hooks` key from `~/.claude/settings.json` (or restore the backup the installer created).

## Codex

```bash
termyte install codex
```

Writes to `~/.codex/hooks.json` (or `./.codex/hooks.json` with `--target project`). Codex's hook surface is narrower than Claude Code's; termyte registers the events Codex supports.

## OpenCode

```bash
termyte install opencode
```

Copies `src/integrations/opencode-plugin/index.ts`'s compiled output into `~/.config/opencode/plugins/termyte.js` and registers it in `~/.config/opencode/opencode.json` under `plugin`. The plugin forwards every OpenCode event to `termyte-hook opencode <event>`.

If `opencode serve` is running, synthesis prefers the HTTP transport. Otherwise it falls back to the CLI.

## Cursor

```bash
termyte install cursor
```

Writes to `~/.cursor/hooks.json`. Cursor's hooks can capture traces, but Cursor itself does not expose a way to drive an LLM programmatically — so synthesis is not automatic. Run `termyte synth --adapter claude-code` (or whichever agent you have installed) from cron, a launchd plist, or a systemd timer to synthesize the captured traces.

## Gemini CLI

```bash
termyte install gemini-cli
```

Writes to `~/.gemini/settings.json`. The Gemini free tier is rate-limited (60 requests/min, 1000 requests/day); termyte's `RateLimiter` respects that automatically. The first invocation may be slow as the synthesis adapter warms up.

## Windsurf

```bash
termyte install windsurf
```

Writes to `~/.codeium/windsurf/hooks.json`. Windsurf has no synthesis CLI and no way to drive an LLM programmatically, so the corpus will only ever contain raw traces. Search still works (via FTS5 keyword + cosine vector).

## MCP-only IDEs

```bash
termyte install mcp:copilot-cli
termyte install mcp:antigravity
termyte install mcp:goose
termyte install mcp:roo-code
termyte install mcp:warp
```

These IDEs don't expose a hook protocol, only MCP. The installer writes an `mcpServers` (or `servers`) entry into the IDE's config and points it at `termyte mcp`. The IDE will then be able to call the search tools from its own model. See [MCP server](./mcp.md) for the tools and protocol details.

## Per-agent config locations

| Agent | User-level | Project-level |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `./.claude/settings.json` |
| Codex | `~/.codex/hooks.json` | `./.codex/hooks.json` |
| OpenCode | `~/.config/opencode/opencode.json` | (project) `./opencode.json` |
| Cursor | `~/.cursor/hooks.json` | `./.cursor/hooks.json` |
| Gemini CLI | `~/.gemini/settings.json` | `./.gemini/settings.json` |
| Windsurf | `~/.codeium/windsurf/hooks.json` | (none) |
| Copilot CLI | `~/.github/copilot/mcp.json` | `./.github/copilot/mcp.json` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | (project) `./.gemini/antigravity/mcp_config.json` |
| Goose | `~/.config/goose/config.yaml` | (none) |
| Roo Code | (managed by Roo) | (managed by Roo) |
| Warp | (managed by Warp) | (managed by Warp) |

## Uninstalling

The installer always creates a backup before overwriting. To uninstall termyte from a specific agent:

1. Find the backup file. It will be named `<original>.<timestamp>.bak` in the same directory.
2. Replace the modified config with the backup, or remove the `hooks` / `plugin` / `mcpServers` key the installer added.

## Re-installing after moving the binary

The installer bakes the absolute path to `termyte-hook` and `termyte mcp` into the agent's config. If you move the `termyte` install (e.g. switching from a global to a `npx`-based install, or upgrading Node versions), re-run the installer:

```bash
termyte install <platform>   # safe to re-run; backs up first
```
