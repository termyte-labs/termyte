# Termyte

A self-correcting memory system for coding agents.

Termyte gives AI coding assistants persistent, validated memories of past actions, fixes, and patterns — so agents "know what they did last time" and avoid repeated mistakes.

## How It Works

```
OpenCode session
   ↓
Hook (termyte hook)
   ↓
Pending messages  →  inline Gemini extraction  →  Observations
                                                    ↓
Memories  ←  confidence 0.5  ──  used by agent  ──  2/3
   ↓                                              (Bayesian update)
Hybrid search (FTS5 + vector) ranked by similarity × confidence × freshness × reliability
   ↓
Injected into next agent context
```

1. **Capture** — OpenCode plugin forwards every event (tool calls, file edits, commands, prompts) to `termyte hook` via stdin
2. **Extract** — Inline Gemini call converts raw events into structured observations (XML format)
3. **Store** — SQLite with FTS5 (keyword) and vec0 (vector) indexes
4. **Retrieve** — Hybrid search ranked by `keyword × semantic × confidence`
5. **Self-Correct** — Track outcomes; successful memories gain confidence, failures lose it
6. **Outcome** — `termyte feedback --memory <id> --outcome success|failure|ignored`

Confidence formula (Bayesian):

```text
(successes + 1) / (successes + failures + 2)
```

## Install

```bash
npm install -g termyte
```

Requires Node.js 20+ and a Gemini API key.

## Quickstart

```bash
# 1. Init termyte in your project
cd your-project
termyte init
export GEMINI_API_KEY=your-key-here

# 2. Install the OpenCode plugin
termyte plugin install
# (use --global for ~/.config/opencode/plugins/)

# 3. Use OpenCode as normal. Termyte auto-captures every event.

# 4. Search memories
termyte search "auth test failure"

# 5. Inject memories into agent context
termyte inject --task "fix the login bug"

# 6. List captured memories
termyte memories list
termyte memories show <id>

# 7. Record an outcome
termyte feedback --memory <id> --outcome success
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `termyte init` | Initialize `.termyte/` directory |
| `termyte plugin install [--global]` | Install the OpenCode plugin (`.opencode/plugins/termyte.ts`) |
| `termyte capture start [--session <id>]` | Start a session capture |
| `termyte capture end --session <id>` | End session |
| `termyte search "<query>" [--scope <scope>]` | Search memories (hybrid FTS5 + vector) |
| `termyte inject --task "<task>" [--scope <s>]` | Generate context block for agents |
| `termyte memories list [--type <type>]` | List stored memories |
| `termyte memories show <id>` | Show memory with feedback stats |
| `termyte feedback --memory <id> --outcome <success\|failure\|ignored>` | Record outcome |
| `termyte decay [--dry-run]` | Apply memory decay |
| `termyte index [--reindex]` | Index memories for vector search |
| `termyte sessions list` | List captured sessions |
| `termyte sessions show <id>` | Show session details |
| `termyte process [--batch <n>]` | Manually flush pending hook messages |
| `termyte hook [--no-process]` | Internal: read hook payload from stdin |
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
  "sources": ["observation-uuid", ...],
  "successCount": 5,
  "failureCount": 2,
  "confidence": 0.71,
  "lastOutcomeAt": "2026-06-20T00:00:00Z"
}
```

Memory types: `fact`, `bugfix`, `procedure`, `convention`, `warning`

## Ranking Formula

```text
score = w_keyword × keyword_score + w_semantic × semantic_score + w_confidence × confidence

default weights:
  w_keyword = 0.3
  w_semantic = 0.4
  w_confidence = 0.3
```

## Tech Stack

- **Storage**: SQLite (better-sqlite3) with FTS5 + sqlite-vec
- **LLM**: Gemini 2.5 Flash (extraction) + gemini-embedding-2 (embeddings)
- **Adapter**: OpenCode plugin + 6 other platform adapters (claude-code, codex, cursor, windsurf, gemini-cli, raw)
- **Language**: TypeScript

## Architecture

```
src/
├── cli.ts                          # CLI entry point
├── db.ts                           # Database schema
├── types.ts                        # TypeScript interfaces
├── capture/                        # Session capture
│   ├── index.ts                    # CaptureEngine
│   ├── hooks.ts                    # Hook normalization
│   ├── git.ts                      # Git utilities
│   └── commands.ts                 # Command utilities
├── extraction/                     # Gemini LLM extraction
│   ├── gemini.ts                   # Gemini client
│   ├── parser.ts                   # XML parser
│   ├── output-classifier.ts        # LLM output classification
│   ├── response-processor.ts       # Observation writer
│   ├── pending-processor.ts        # Batch LLM processor
│   ├── prompts.ts                  # Memory extraction prompts
│   ├── prompts-observer.ts         # Observation prompt
│   └── index.ts                    # Extraction entry
├── memory/                         # Memory storage & confidence
│   ├── schema.ts                   # MemoryStore (CRUD + FTS sync)
│   ├── index.ts                    # MemoryEngine
│   ├── confidence.ts               # Bayesian scoring
│   ├── outcome.ts                  # Outcome recording
│   └── decay.ts                    # Memory decay
├── retrieval/                      # Hybrid search & ranking
│   ├── fts.ts                      # FTS5 keyword search
│   ├── vector.ts                   # Vector search
│   ├── ranking.ts                  # Weighted ranking
│   ├── inject.ts                   # Context block builder
│   └── index.ts                    # RetrievalEngine
├── feedback/                       # Outcome tracking
├── hook-system/                    # Hook event handling
│   ├── adapters.ts                 # 7 platform adapters (incl. OpenCode)
│   ├── index.ts                    # Hook command entry
│   ├── hook-io.ts                  # I/O utilities
│   ├── logger.ts                   # Logging
│   ├── session-store.ts            # Session CRUD
│   ├── session-search.ts           # FTS observation search
│   └── opencode-plugin.template.ts # OpenCode plugin (auto-installed)
└── ast/                            # Tree-sitter AST anchors
```

## Tests

```bash
npm test
```

34 tests, all passing. Includes:
- 29 unit tests (database, confidence, decay, outcome, ranking, XML parser, output classifier)
- 5 e2e tests (full hook → pending → observations → memories → retrieval → outcome loop)

## Roadmap

- **Phase 1 (Done)**: Capture + Store + Basic Retrieval
- **Phase 2 (Done)**: Self-Correction (outcome tracking, confidence updates)
- **Phase 3 (Done)**: OpenCode integration + e2e pipeline
- **Phase 4 (Future)**: Memory decay tuning, additional platform adapters

## License

MIT
