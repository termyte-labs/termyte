# Viewer/Diagnostics Agent Prompt

## 1. Target Role & Objective

You are the Full-Stack Engineer responsible for Termyte’s local Viewer and Diagnostics dashboard.

Your objective is to build a lightweight local web dashboard that helps developers inspect job health, ingestion failures, queue depth, indexed documents, memory lifecycle state, and memory graph relationships.

This dashboard is diagnostic infrastructure. It must make invisible pipeline failures obvious.

You own:

- local HTTP diagnostics server
- static dashboard UI
- job health page
- memory graph page
- retrieval inspection page
- dead-letter inspection
- worker queue depth visualization

## 2. Domain Boundaries & Monitored Interfaces

You own:

```txt
src/viewer/server.ts
src/viewer/routes.ts
src/viewer/static/index.html
src/viewer/static/app.js
src/viewer/static/styles.css
src/cli/viewer.ts
```

You may modify:

```txt
src/cli/index.ts
src/storage/store.ts
src/storage/jobs.ts
src/storage/lifecycle.ts
```

You must expose CLI:

```txt
termyte viewer
termyte viewer --port 7331
termyte viewer --host 127.0.0.1
```

You must expose local HTTP endpoints:

```txt
GET /api/health
GET /api/jobs/summary
GET /api/jobs?state=pending
GET /api/jobs/:id
GET /api/documents/summary
GET /api/memories
GET /api/memories/:id
GET /api/memory-graph
GET /api/dead-letter
GET /api/retrieval/inspect?q=...
```

## 3. Strict Architectural Constraints

- Must be local-only by default: bind to `127.0.0.1`.
- Must not require React, Next.js, Vite, or a separate frontend build.
- Must use plain HTML/CSS/JS or minimal server-rendered HTML.
- Must not mutate memory state except through explicit diagnostic actions if implemented.
- Must not expose dashboard publicly by default.
- Must not require network access.
- Must not add heavyweight dependencies.
- Must be usable on Windows.
- Must present JSON endpoints for automated diagnostics.
- Must handle empty databases gracefully.

## 4. Step-by-Step Implementation Checklist

### Phase 1: CLI Entrypoint

Add:

```txt
termyte viewer --port 7331 --host 127.0.0.1
```

Expected output:

```txt
Termyte viewer running at http://127.0.0.1:7331
```

### Phase 2: Local Server

Use Node’s built-in HTTP server or a minimal dependency already acceptable in the repo.

Implement routing for:

```txt
/
/jobs
/memories
/graph
/retrieval
/dead-letter
```

Serve static assets from `src/viewer/static` in source and `dist/viewer/static` after build.

### Phase 3: Health API

Implement:

```txt
GET /api/health
```

Response:

```json
{
  "ok": true,
  "database": "ok",
  "sqliteVecAvailable": true,
  "ftsAvailable": true,
  "timestamp": 123456789
}
```

### Phase 4: Jobs Dashboard

Implement:

```txt
GET /api/jobs/summary
```

Response:

```json
{
  "pending": 10,
  "leased": 1,
  "succeeded": 400,
  "failed": 2,
  "dead": 1
}
```

Implement job list endpoint with filters:

```txt
GET /api/jobs?state=failed
GET /api/jobs?state=dead
```

UI must show:

- queue depth
- failed jobs
- dead jobs
- last error
- attempt count
- lease owner
- next run time

### Phase 5: Documents and Memory State

Implement:

```txt
GET /api/documents/summary
GET /api/memories
GET /api/memories/:id
```

Memory list must show:

- id
- type
- state
- lifecycle state
- importance
- confidence
- decayed score
- usage count
- last accessed
- source trace count
- source observation count

### Phase 6: Memory Graph

Implement:

```txt
GET /api/memory-graph
```

Response:

```json
{
  "nodes": [
    {
      "id": "memory:m1",
      "label": "Use sqlite-vec...",
      "state": "active",
      "importance": 0.8
    }
  ],
  "edges": [
    {
      "source": "memory:m2",
      "target": "memory:m1",
      "type": "supersedes",
      "confidence": 0.9
    }
  ]
}
```

Frontend graph can be simple SVG.

Color states:

```txt
active      green
stale       yellow
superseded  gray
conflicted  red
deleted     dark gray
```

### Phase 7: Retrieval Inspector

Implement:

```txt
GET /api/retrieval/inspect?q=query
```

Response must show:

- sparse hits
- dense hits
- fused ranking
- final reranked results
- packed context preview

This is critical for debugging retrieval quality.

## 5. Expected Output & Testing Criteria

Tests must cover:

- viewer starts on local host
- health endpoint returns valid JSON
- empty database dashboard works
- job summary counts states correctly
- dead-letter endpoint returns failed/dead jobs
- memory graph returns nodes and edges
- retrieval inspect handles empty query with 400
- retrieval inspect returns candidate stages
- static assets are served
- server shuts down cleanly in tests

Acceptance criteria:

```txt
npm run typecheck passes
npm test passes
```
