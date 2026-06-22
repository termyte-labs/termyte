# Termyte

A self-correcting memory system for coding agents.

Termyte gives AI coding assistants persistent, validated memories of past actions, fixes, and patterns — so agents "know what they did last time" and avoid repeated mistakes.

## How It Works

```
Agent Session → Capture → Gemini Extraction → Memory Store (SQLite + FTS5 + vector)
                                                        ↓
New Task → Query → Hybrid Search → Rank → Inject into Agent Context
                                                        ↓
Agent Uses Memory → Monitor Outcomes → Update Confidence → Decay Stale Memories
```

1. **Capture** — Records agent session traces (commands, file changes, test results, diffs)
2. **Extract** — Uses Gemini to extract structured memory claims from traces
3. **Store** — SQLite with FTS5 (keyword) and vec0 (vector) indexes
4. **Retrieve** — Hybrid search ranked by `similarity × confidence × freshness × reliability`
5. **Self-Correct** — Tracks outcomes; successful memories gain confidence, failures lose it
6. **Decay** — Automatically reduces confidence for stale or contradicted memories

## Install

```bash
npm install -g termyte
```

Requires Node.js 20+ and a Gemini API key.

## Quickstart

```bash
# Initialize in your project
cd your-project
termyte init

# Set your Gemini API key
export GEMINI_API_KEY=your-key-here

# Start capturing a session
termyte capture start --agent claude

# Record events during the session
termyte capture event --session <id> --type command --summary "npm test"
termyte capture event --session <id> --type test_run --summary "Tests passed"

# End session and extract memories
termyte capture end --session <id>

# Search memories
termyte search "auth test failure"

# Inject memories into agent context
termyte inject --task "fix the login bug"

# View stored memories
termyte memories list
termyte memories show <id>

# Record feedback on memory usage
termyte feedback --memory <id> --outcome success

# Apply memory decay
termyte decay --dry-run
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `termyte init` | Initialize `.termyte/` directory |
| `termyte capture start --agent <name>` | Start a session capture |
| `termyte capture end --session <id>` | End session and extract memories |
| `termyte capture event --session <id> --type <type> --summary <text>` | Record an event |
| `termyte search "<query>"` | Search memories (hybrid FTS5 + vector) |
| `termyte inject --task "<task>"` | Generate context block for agents |
| `termyte memories list` | List stored memories |
| `termyte memories show <id>` | Show memory with feedback stats |
| `termyte feedback --memory <id> --outcome <success\|failure\|ignored>` | Record outcome |
| `termyte decay [--dry-run]` | Apply memory decay |
| `termyte index [--reindex]` | Index memories for vector search |
| `termyte sessions list` | List captured sessions |
| `termyte stats` | Show memory statistics |

## Memory Schema

Each memory is an evidence-backed claim:

```json
{
  "id": "uuid",
  "claim": "Auth tests fail when middleware config is stale",
  "type": "bugfix",
  "repoScope": "my-project",
  "language": "typescript",
  "sources": ["session-uuid", "event-uuid"],
  "successCount": 5,
  "failureCount": 2,
  "confidence": 0.71,
  "lastVerified": "2026-06-20T00:00:00Z"
}
```

Memory types: `fact`, `bugfix`, `procedure`, `convention`, `warning`

## Ranking Formula

```
score = similarity × confidence × freshness × reliability

where:
  freshness = exp(-age_days / 60)
  reliability = (success_count + 1) / (success_count + failure_count + 2)
```

## Tech Stack

- **Storage**: SQLite (better-sqlite3) with FTS5 + sqlite-vec
- **LLM**: Gemini 2.5 Flash (extraction) + gemini-embedding-2 (embeddings)
- **Code Parsing**: Tree-Sitter for AST anchors
- **Language**: TypeScript

## Architecture

```
src/
├── cli.ts                    # CLI entry point
├── db.ts                     # Database schema & migrations
├── types.ts                  # TypeScript interfaces
├── capture/                  # Session & event capture
├── extraction/               # Gemini LLM extraction
├── memory/                   # Memory storage & confidence
├── retrieval/                # Hybrid search & ranking
├── feedback/                 # Outcome tracking
├── procedures/               # Workflow mining (Phase 3)
└── ast/                      # Tree-Sitter integration
```

## Roadmap

- **Phase 1 (Current)**: Capture + Store + Basic Retrieval
- **Phase 2**: Self-Correction (outcome tracking, confidence updates, decay)
- **Phase 3**: Advanced (procedure mining, contradiction detection, consolidation)

## License

MIT
