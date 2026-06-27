# MCP server

Termyte ships a stdio MCP server (`termyte mcp`) that exposes the memory corpus to any MCP-compatible IDE: Copilot CLI, Antigravity, Goose, Roo Code, Warp, and any custom MCP client.

The server speaks **JSON-RPC 2.0** over stdin/stdout. It is a single-process, synchronous-from-the-agent's-perspective server — tools return text content blocks, errors become `isError: true` results so the IDE can surface them to the model.

## Starting the server

The install command wires it up for you:

```bash
termyte install mcp:copilot-cli
termyte install mcp:antigravity
termyte install mcp:goose
termyte install mcp:roo-code
termyte install mcp:warp
```

To run it manually for an MCP client that doesn't have an installer (or for testing):

```bash
# In an MCP client config:
{
  "mcpServers": {
    "termyte": {
      "command": "node",
      "args": ["/path/to/termyte/dist/cli/index.js", "mcp"]
    }
  }
}
```

Or via `npx`:

```json
{
  "mcpServers": {
    "termyte": {
      "command": "npx",
      "args": ["-y", "termyte", "mcp"]
    }
  }
}
```

## Tools

| Tool | Input | Output |
|---|---|---|
| `search_memories` | `{ query, limit?, repo_id?, currentFiles? }` | A ranked list of memories as markdown. |
| `get_memory` | `{ id }` | A single memory as markdown. |
| `get_recent_sessions` | `{ limit? }` | One session id per line. |
| `get_session` | `{ session_id }` | Session metadata + optional summary. |
| `get_observations_for_session` | `{ session_id, limit? }` | One observation per line. |

### `search_memories`

The most useful tool. Equivalent to `termyte search` but returns the rendered markdown directly.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_memories",
    "arguments": {
      "query": "how does authentication work",
      "limit": 5,
      "currentFiles": ["src/auth.ts"]
    }
  }
}
```

| Argument | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | Natural-language query. |
| `limit` | number | no | Default 20. |
| `repo_id` | string | no | Restrict to a specific repository. |
| `currentFiles` | string[] | no | Triggers file-aware boosting. |

The response is a text content block with markdown formatted like:

```markdown
## Memories

### #14 [convention] JWT verification uses HS256 with shared secret
The token signing key is loaded from `JWT_SECRET` env var. Tokens are
validated on every request in `src/middleware/auth.ts`.

  repo: github.com/termyte-labs/termyte | session: abc-123

### #22 [warning] Don't add `;` to .d.ts files
...
```

### `get_memory`

```json
{ "name": "get_memory", "arguments": { "id": 14 } }
```

Returns a single memory as markdown. If the id doesn't exist, returns an `isError: true` result with the message `(no memory with id 14)`.

### `get_recent_sessions`

```json
{ "name": "get_recent_sessions", "arguments": { "limit": 10 } }
```

Returns one session per line in the format `<session_id>  <project>  <repo_id>  <active|ended>  <started_at_iso>`.

### `get_session`

```json
{ "name": "get_session", "arguments": { "session_id": "abc-123" } }
```

Returns session metadata plus the summary, if one exists.

### `get_observations_for_session`

```json
{ "name": "get_observations_for_session", "arguments": { "session_id": "abc-123", "limit": 50 } }
```

Returns one observation per line in the format `#<id> [<type>] <title>`.

## Lifecycle

The server is started by the IDE, runs in the background, and shuts down when the IDE exits. It opens the SQLite file in WAL mode so it can coexist with `termyte synth` and `termyte-hook`. There is no authentication — the server is local-only and reachable only via stdio.

## Protocol version

`initialize` returns `protocolVersion: "2024-11-05"`. Update your MCP client to a version that supports this protocol (most clients from late 2024 onward do).

## What the server does NOT do

- It does not drive synthesis. `termyte mcp` is read-only against the corpus. To convert traces into memories, run `termyte synth` (typically on a timer or as a session-end hook).
- It does not open any network port. Everything is over stdio.
- It does not embed or rerank results. The hybrid search is performed exactly the same way as `termyte search`.

## Troubleshooting the MCP server

- **Tools return `(embedding model not ready)` text** — the local ONNX model is still loading on first call. Subsequent calls are fast.
- **Tools return `(no results)`** — the corpus is empty, or the `query` is too narrow. Run `termyte stats` to confirm.
- **The IDE can't find `termyte mcp`** — the installer bakes an absolute path. If you moved the binary, re-run the installer.
