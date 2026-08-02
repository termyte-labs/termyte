# How it works

Termyte has one runtime path:

```text
Claude Code or Codex hook
  -> normalize and redact the event
  -> store the raw trace in local SQLite
  -> on the next SessionStart, load the previous session and current Git state
  -> make one call through the selected agent's existing login
  -> store and inject the colleague-style handoff
```

There is no worker, job queue, embedding model, vector index, memory lifecycle, dashboard, or manual consolidation command.

Mid-session questions about earlier work use SQLite full-text search over stored handoffs.
