# Contributing to Termyte

Thanks for your interest in Termyte. The codebase is intentionally small (around 3,000 LOC of TypeScript) and the architecture is documented in [`AGENTS.md`](./AGENTS.md). New contributors can usually get a pull request merged within a day or two if it follows the conventions below.

## Development setup

Requirements:

- Node.js >= 20
- A C/C++ toolchain (for `better-sqlite3` and `sqlite-vec` native builds)
- Git

```bash
git clone https://github.com/termyte-labs/termyte.git
cd termyte
npm install
npm test          # full test suite (Vitest, in-memory SQLite, no network)
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/
```

Tests are deterministic: they use an in-memory SQLite database, a mock LLM, and a fixed-dimension FNV-hash embeddings provider. No API keys are required to run the suite.

## Project layout

```
src/
  core/        — shared types (Trace, Observation, Memory, Summary, Session)
  capture/     — platform adapters (Claude Code, Codex, OpenCode, Cursor, Gemini, Windsurf) + Ingestor
  storage/     — SQLite wrapper, schema migrations, CRUD
  observer/    — LLM-based observation extraction
  synth/       — background synthesis pipeline (one-shot CLI)
  retrieval/   — hybrid FTS5 + vector search
  hooks/       — stdin -> adapter -> ingest driver
  context/     — markdown rendering for agent prompts
  cli/         — CLI entry points (install, search, context, synth, stats, mcp)
  mcp/         — stdio MCP server
  integrations/ — agent installers + opencode plugin
test/          — Vitest suite (mock-llm.ts, in-memory DB)
docs/          — design + mitigation notes
AGENTS.md      — codebase-level architecture notes
```

## Conventions

- **TypeScript strict mode, ESM, NodeNext resolution.** All imports use `.js` extensions even though the source is `.ts` — this is required by NodeNext.
- **No comments unless they explain *why*.** Code should be self-documenting; comments are reserved for non-obvious tradeoffs.
- **No new dependencies unless they earn their place.** Prefer the standard library and existing dependencies (`better-sqlite3`, `@xenova/transformers`, `sqlite-vec`).
- **Match existing style.** Read neighboring files before editing.
- **Tests are required for new behavior.** Bug fixes need a regression test.
- **Crash-safety.** Anything that processes a trace must update `processed_at` only after success so a crashed run is recoverable.
- **Boundedness.** Anything that talks to an LLM must respect the daily budget caps and per-batch timeouts.

## Adding a new agent adapter

1. Create `src/capture/<agent>.ts` implementing the `PlatformAdapter` interface from `src/capture/adapter.ts`.
2. Add an installer under `src/integrations/installers/<agent>.ts` and wire it into `src/integrations/installers/index.ts`.
3. Register the platform id in `termyte install <agent>` and in `src/integrations/types.ts`.
4. Add a synthetic-adapter implementation in `src/synth/<agent>.ts` if the agent can drive synthesis; otherwise mark it manual in the README table.
5. Add unit tests in `test/adapters.test.ts` and a synthetic test in `test/synth-<agent>.test.ts`.
6. Update the supported-agents table in `README.md` and `llm.txt`.

## Adding a new synthesis adapter

1. Create `src/synth/<agent>.ts` implementing the synthesis interface.
2. Add it to `src/synth/index.ts` and the `discoverAdapter()` / `createAdapter()` registry.
3. Add tests under `test/synth-<agent>.test.ts`.
4. Update `README.md` and `llm.txt`.

## Pull request process

1. Open an issue first for anything non-trivial so we can agree on the approach.
2. Fork the repo and create a feature branch off `main`.
3. Make your changes with tests.
4. Run `npm run typecheck && npm test` locally and confirm both pass.
5. Use the PR template — fill in the "what" and the "why" clearly.
6. Squash-merge is the default; the maintainer may rebase to clean up history.
7. CI must be green before merge.

## Commit messages

Follow the existing prefix style:

- `feat:` for new user-facing capability
- `fix:` for bug fixes
- `refactor:` for internal restructuring with no behavior change
- `perf:` for performance work
- `test:` for test-only changes
- `docs:` for documentation only
- `chore:` for releases, dependency bumps, and toolchain config

Keep the subject under 72 characters and the body focused on *why* rather than *what*.

## Reporting bugs

Use the bug report issue template. Include:

- Termyte version (`termyte --version` or the commit SHA)
- Node version (`node -v`)
- Agent and agent version (e.g. Claude Code `claude --version`)
- OS and architecture
- Reproduction steps and observed vs. expected behavior
- Relevant `termyte stats` output and the relevant `termyte.db` schema (not the data itself)

## Security issues

Please do **not** file a public issue. See [`SECURITY.md`](./SECURITY.md) for the disclosure process.

## Code of conduct

By participating you agree to abide by the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
