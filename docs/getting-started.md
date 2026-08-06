# Getting started

Install Termyte and initialize it once:

```bash
npm install -g termyte
termyte init
```

Termyte detects Codex and Claude Code, installs user-level hooks for all detected agents, creates `~/.termyte/config.json`, and initializes local SQLite. The hooks then run across all projects. Stored sessions and retrieved experience are filtered by repository identity, so context does not cross between unrelated projects. When both agents are installed, select the one Termyte should use for reflection and context selection.

Work normally. Capture is silent. After a meaningful session ends, reflection runs outside the active hook. A later session receives the project briefing before its first response, and each prompt receives relevant prior experience when available.

## Configuration

The generated config contains:

```json
{
  "version": 1,
  "dbPath": ".../.termyte/termyte.db",
  "agent": "codex",
  "agents": ["codex", "claude-code"],
  "briefingTokenLimit": 800,
  "promptTokenLimit": 300,
  "catalogueTokenLimit": 4000,
  "selectionTimeoutMs": 5000
}
```

The token limits are converted to conservative character budgets. `TERMYTE_HOME` changes the Termyte directory and `TERMYTE_DB` overrides the database path.

## Data and privacy

Termyte stores sanitized raw events and derived experience locally. Reflection sends selected redacted session evidence to the configured existing coding agent. Redaction catches common patterns but cannot guarantee that every secret is removed, so review your repository and provider policies before using Termyte with highly sensitive work.
