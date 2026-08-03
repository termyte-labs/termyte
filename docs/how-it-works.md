# How it works

Termyte has three local runtime paths: capture, next-session handoff, and explicit recall.

```text
Claude Code or Codex hook
  -> normalize and redact the event
  -> store the raw trace in local SQLite
  -> on the next SessionStart, load the previous session and current Git state
  -> build and save a deterministic handoff
  -> inject the handoff before the agent's first response
```

The handoff uses the latest previous request, final response, four recent tool actions, and current Git state when available. Termyte does not call a model to summarize this data.

## Full-text retrieval

Mid-session questions about earlier work use an FTS5 index over saved handoffs. Termyte:

1. Detects phrases such as `why`, `previous`, `last time`, or `decision`.
2. Extracts up to 12 terms of at least three characters.
3. Joins those terms with FTS5 `OR` queries.
4. Filters results to the current repository.
5. Orders matches with FTS5 `bm25()` and returns up to three.

This is fast local keyword retrieval. It has no stop-word removal, phrase-aware query building, semantic embeddings, freshness weighting, or minimum relevance score. Recall searches handoffs, not raw traces.

## Current boundaries

There is no worker, job queue, embedding model, vector index, memory lifecycle, dashboard, cloud sync, or manual consolidation command. An empty recent session can also be selected ahead of an older meaningful session, and the full handoff does not yet have a total size limit.
