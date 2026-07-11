# Termyte Context Engine v0.1 Plan

Updated: 2026-07-11

| Task | Lead | Status | Acceptance evidence |
|---|---|---|---|
| REL-001 Package baseline and product contract | Runtime | completed | 329 tests pass; typecheck/build pass; packed install and every declared binary execute |
| MEM-001 Episodes, evidence, outcomes, and provenance | Memory Modeling | completed | Episode/evidence/outcome migrations, deterministic recorder tests, and packed trace-to-memory proof pass |
| RUN-001 Invisible Claude/Codex runtime and synthesis | Runtime | in_progress | Silent foreground FTS fallback and worker failure/recovery are proven; live authenticated agent synthesis remains |
| ONB-001 `termyte init` and uninstall | Runtime | completed | Clean-home config/database test and Claude/Codex installer tests pass; API mode rejects missing key |
| CTX-001 Persisted task context compiler | Retrieval | in_progress | Packets, candidates, budgets, feedback and injection persistence exist; experience previews and controlled harmful-recall proof remain |
| VIEW-001 Local Viewer trust surface | Retrieval | in_progress | Viewer API tests and production UI build pass; browser smoke and data-management surface remain |
| EVAL-001 Product and package proof | Evaluation | pending | Tier 3 validation and controlled live-agent evidence |

No task is complete until every acceptance criterion in the approved design passes. Product-value claims require controlled agent evidence; component tests alone are insufficient.
