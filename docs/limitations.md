# Limitations

Termyte works, but it is not finished.

## Current Limits

- It is not self-correcting yet.
- Outcome attribution is not closed end to end.
- Correction text is not verified against repository evidence before replacement.
- Redaction is heuristic, so sensitive-data handling still needs review for high-risk repos.
- Ranking calibration is still incomplete.
- OpenCode context injection still uses a shared file refresh path instead of a true live injected memory object.
- The benchmark harness is a regression harness, not public proof of real-world agent gains.

## Practical Meaning

Use Termyte for:

- local trace capture
- task episode and evidence inspection
- durable processing
- searchable coding experience
- compact context cards with explicit drill-down
- provenance and explainability

Do not use the current version as if it were already a self-healing memory system.
