# Limitations

Termyte works, but it is not finished.

## Current Limits

- Attribution is heuristic and deterministic, not causal proof that context produced an outcome.
- Ambiguous cases remain `unknown`; generic memories without applicability signals are not force-classified.
- Inferred `unused` does not penalize ranking, and harm requires explicit harmful or corrected feedback.
- Corrections depend on repository evidence becoming available to the verification worker; otherwise the memory remains conflicted.
- Redaction is heuristic, so sensitive-data handling still needs review for high-risk repos.
- Ranking calibration is still incomplete.
- Claude Code, Codex, and OpenCode capture and non-interactive synthesis are supported; OpenCode automatic context injection is not.
- OpenCode uses a generated local plugin and still needs published live acceptance proof.
- Task data is available through CLI, MCP, context injection, and Viewer APIs; the Viewer has no task-management UI.
- Import, export, bulk deletion, and Claude-Mem migration are not implemented.
- Execution projections are intentionally narrow: tool calls represent captured completion events and file changes cover captured reads/modifications.
- The deterministic benchmark and closed-loop harnesses are regression proof, not public proof of real-world agent gains.

## Practical Meaning

Use Termyte for:

- local trace capture
- task, session, and evidence inspection
- durable processing
- searchable coding experience
- compact context cards with explicit drill-down
- evidence-backed task state, Git checkpoints, resume packets, and handoffs
- provenance and explainability

Use effect verdicts as inspectable evidence, not as a claim that Termyte caused task success. Run controlled paired-agent trials before making improvement claims.
