# Termyte Context Engine v0.1 Trial Protocol

## Purpose

Measure whether Termyte is associated with better repeated-repository agent outcomes without turning a small paired trial into a causal marketing claim. Repository tests and packed-install gates prove mechanics; this protocol evaluates product utility with real Claude Code and Codex sessions.

## Release minimum

- One packed-install end-to-end run with Claude Code and one with Codex.
- At least 20 paired trials. Every task is run once with Termyte enabled and once with Termyte disabled.
- At least one adversarial unrelated task that should produce a correct abstention.
- A written disposition for every harmful-context event.
- No public claim stronger than the measured evidence and uncertainty support.

## Trial artifacts

Set `TERMYTE_TRIAL_ROOT` to a directory outside this repository and npm package. Store one immutable directory per run:

```text
<trial-root>/<pair-id>/<condition>/
  environment.json
  task.json
  transcript.jsonl
  validations.json
  termyte-report.json
  grade.json
  review.md
```

Do not commit raw transcripts, credentials, user data, or generated reports. Redact secrets before review.

## Task manifest

Freeze the task set before running trials. Each `task.json` must contain:

```json
{
  "pairId": "pair-001",
  "repositoryCommit": "full commit SHA",
  "task": "deterministic task statement",
  "allowedCommands": ["npm test"],
  "successChecks": ["named test passes", "expected file behavior"],
  "timeoutMinutes": 20,
  "agent": "claude-code",
  "condition": "termyte-on",
  "order": 1
}
```

Use tasks with deterministic checks and meaningful prior repository context. Exclude tasks whose answer depends on live network state, subjective style, or unavailable credentials.

## Assignment and isolation

1. Reset each run to the same clean repository commit and dependency cache state.
2. Counterbalance order within pairs: odd pair IDs run Termyte on then off; even pair IDs run off then on.
3. Alternate Claude Code and Codex across pair IDs so agent and order are not confounded with condition.
4. Use a fresh agent conversation, home directory, database, and output directory for every run.
5. Keep model, model settings, tool permissions, task text, timeout, machine, and dependency state identical within a pair.
6. For the off condition, do not install hooks and verify no Termyte worker or context injection is active.
7. For the on condition, install the packed tarball, run `termyte init`, and require a passing `termyte doctor --json` before the task.

## Environment capture

Record before each run:

- UTC timestamp, pair ID, condition, and order;
- OS, CPU, memory, Node and npm versions;
- repository URL or stable identifier and exact commit SHA;
- dirty-worktree status and dependency-lock hash;
- agent name/version, model, and non-secret settings;
- Termyte tarball SHA-256 and `doctor --json` output for on runs;
- timeout and deterministic success commands.

If any within-pair environment field differs unexpectedly, invalidate and rerun the pair.

## Run procedure

1. Prepare the isolated checkout and capture `environment.json`.
2. Apply the assigned condition and verify it.
3. Start a fresh agent conversation with the frozen task text only.
4. Capture the complete timestamped transcript and tool events.
5. Stop at success, explicit agent completion, unrecoverable failure, or timeout.
6. Run the frozen validation commands independently of the agent.
7. For Termyte-on runs, export local Viewer/API evidence for episodes, packets, selected and rejected candidates, injections, outcomes, queue health, and feedback.
8. Hash artifacts and make the run directory read-only before grading.

Do not repair a run manually. Record infrastructure failures separately and rerun the full pair only after the cause is resolved.

## Measurements

Record the following for both conditions:

- binary task success and each validation result;
- elapsed wall time;
- agent turns and tool calls;
- input/context/output tokens when the agent exposes them;
- files read and modified;
- tests/builds attempted and their final status;
- timeout, crash, or infrastructure failure;
- human intervention count.

Additionally record for Termyte-on runs:

- context packet and injection IDs;
- selected/rejected candidate counts and rejection reasons;
- estimated injected context tokens;
- abstention status;
- explicit helpful, harmful, ignored, or corrected feedback;
- whether injected context was demonstrably used in the transcript.
- each persisted context-effect verdict (`helped`, `hurt`, `unused`, or `unknown`), its confidence, signals, episode outcome, packet ID, and injection ID;
- attribution coverage: non-unknown effects divided by all selected candidates;
- helpful and harmful effect rates over all selected candidates.

Do not infer usefulness from `shown` or mere exposure.

Before paired trials, run `npm test -- test/eval/harness.test.ts`. The closed-loop case must report complete attribution, one deterministic helped case, one deterministic hurt case, zero retry duplicates, and a correct adversarial abstention. This proves mechanics only; it does not replace paired-agent utility evidence.

## Grading

Grade from the frozen success checks and independent validation output. The grader must not see the condition, Termyte report, or run order until the initial grade is locked.

`grade.json` must include task success, check-by-check results, failure category, confidence, and a short evidence citation into the transcript or validation log. A second reviewer resolves ambiguous grades without changing the task rubric.

## Abstention and harmful-context review

Include unrelated-repository and stale-guidance tasks. A correct abstention means no prior memory is selected or injected while current task state may still be shown.

For every harmful event, create `review.md` with:

- the injected candidate and provenance;
- why it was harmful, stale, conflicting, or misapplied;
- the ranking and lifecycle state at selection time;
- task impact;
- correction or suppression action;
- regression test or a written reason no code change is required;
- owner and disposition status.

Any unresolved harmful regression blocks release.

## Analysis

Analyze matched pairs, not independent runs. Report:

- wins, ties, and losses on task success;
- paired differences for elapsed time, turns, tool calls, and tokens;
- median and interquartile range for continuous differences;
- bootstrap 95% confidence intervals over pairs;
- abstention precision for the deliberately unrelated cases;
- harmful-context count and disposition summary;
- context-effect verdict counts, attribution coverage, helpful rate, harmful rate, and unknown rate;
- invalidated pairs and infrastructure failures.

Twenty pairs are a product signal, not proof of causality. Describe results as observed associations under this task set, agent set, and environment. Publish the task manifest, grading rubric, aggregate metrics, and limitations before making comparative claims.

## Release decision

Release remains blocked if either supported agent fails its packed-install flow, Recall@5 falls below 0.90, episode work is unbounded or overdue, provenance is broken, unsafe lifecycle items enter packets, token budgets are exceeded, the adversarial task fails to abstain, aggregate tests time out, or a harmful-context regression is unresolved.
