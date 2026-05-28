# Termyte

Local-first runtime safety and operational memory for AI coding agents.

> Benchmark: 180+ dangerous/safe agent actions, 0 false negatives on the current suite.

## Disclaimer

- Shell-first v0.1
- Local-first
- Not a sandbox yet
- MCP integration is coming next

## 30-Second Demo

```bash
npm install
npm run build
termyte inspect -- "rm -rf *"
termyte run -- echo hello
termyte replay
```

## Demo Commands

```bash
termyte inspect -- "rm -rf *"
termyte inspect -- "Remove-Item -Recurse -Force *"
termyte inspect -- "git push --force origin main"
termyte inspect -- "DROP TABLE users"
termyte replay
termyte logs --json
```

## What It Shows

- Semantic parsing of dangerous commands
- Target resolution and sensitive-path detection
- Blast-radius scoring
- Memory matches and learned lessons
- Final allow, warn, or block decisions
- Replayable incident timelines

## CLI

- `termyte run -- <command>`
- `termyte inspect -- <command>`
- `termyte logs`
- `termyte replay`
- `termyte memory`
- `termyte policies`

## JSON Output

Use `--json` with:

- `termyte inspect --json -- "<command>"`
- `termyte logs --json`
- `termyte replay --json`
- `termyte memory --json`
