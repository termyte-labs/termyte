# Changelog

All notable changes to Termyte are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-28

First public release of Termyte. Local-first memory layer for AI coding agents.

### Added

- Hook-based capture for Claude Code, Codex, OpenCode, Cursor, Gemini CLI, and Windsurf via `termyte install <agent>`.
- Background synthesis via `termyte synth`, driven by the user's existing coding-agent LLM (no separate API key required). Pluggable synthesis adapter interface with implementations for Claude Code, Codex, OpenCode, and Gemini CLI.
- MCP stdio server (`termyte mcp`) for any MCP-compatible IDE (Copilot CLI, Antigravity, Goose, Roo, Warp, etc.).
- Hybrid FTS5 + vector search with file-aware boosting and reciprocal-rank fusion.
- Local ONNX embeddings (Nomic Embed v1.5 default, BGE Small fallback) — no embedding API key required.
- Optional `sqlite-vec` native extension for vector search; falls back to in-memory cosine similarity if unavailable.
- OpenCode plugin via `src/integrations/opencode-plugin/`.
- Daily invocation and cost budget caps for synthesis (`TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS`, `TERMYTE_SYNTH_DAILY_BUDGET_USD`).
- Per-batch synthesis timeout (`TERMYTE_SYNTH_TIMEOUT_MS`) and 50-trace / 5-batch cap per run.
- Spend module with SHA-256 daily checksum, process-level embeddings singleton, lean/fat hook paths.
- Crash safety: `processed_at` columns on `traces` and `observations` ensure interrupted runs are recoverable.
- Installer backups (`src/integrations/installers/backup.ts`) that preserve user-edited configs.
- 155 tests across 20 files, all network-free: in-memory SQLite, `MockLLM`, deterministic FNV-hash embeddings.
- `AGENTS.md` with architecture overview for AI-assisted development.
- `docs/mitigation_plan.md` and `docs/post-mitigation-rescan.md` for the performance / reliability / cost mitigations applied before launch.
- Open-source project files: `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `llm.txt`, `robots.txt`, GitHub issue and PR templates.

### Security

- All installer paths validate against `src/integrations/install-paths.ts` to prevent arbitrary-file writes.
- Backup-before-overwrite for any user-edited config file.
- Synthesis LLM call is bounded by daily caps and per-batch timeouts to limit cost and prompt-injection blast radius.

[1.0.0]: https://github.com/termyte-labs/termyte/releases/tag/v1.0.0
