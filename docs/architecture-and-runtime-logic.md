# Architecture and Runtime Logic

## System Overview

Termyte has shared analysis primitives and two main decision paths:

```text
                         +--------------------+
command text ----------> | parser + resolver  |
                         | + risk engine      |
                         +----------+---------+
                                    |
                    +---------------+----------------+
                    |                                |
          stable check path                 experimental runtime path
          YAML policy layers                SQLite semantic policy
          exact JSONL memory                semantic SQLite memory
          JSONL check event                 pending/finalized ledger
          never executes                    may execute or intercept
```

The shared primitives are implemented in `parser.ts`, `resolver.ts`, and
`risk.ts`. The check path starts in `check.ts`. The direct execution path starts
in `runtime.ts`. The governed shell path starts in `shell.ts`.

The launchable agent tool path starts in `mcp.ts`. It exposes Termyte-governed
tools over stdio MCP and routes them through the same parser, target
resolution, risk, policy, memory, and ledger logic used elsewhere.

## Stable Check Flow

`termyte check "<command>"` uses this sequence:

1. `checkCommand` calls `inspectCommand`.
2. `parseAction` tokenizes and classifies the command.
3. `resolveTargets` resolves and classifies visible targets.
4. `analyzeRisk` creates the baseline decision, score, reason, and signals.
5. `loadPhaseOnePolicies` loads built-in, global, and local YAML layers.
6. `mergePhaseOnePolicies` combines every rule without allowing one layer to
   erase another.
7. `evaluatePhaseOnePolicy` matches rules and chooses the strongest decision
   across risk plus matching rules.
8. `matchLocalMemory` performs an exact normalized-command lookup.
9. Unsafe memory upgrades `allow` to `warn`; it cannot weaken stronger results.
10. `writeLocalLog` appends a redacted JSONL event.
11. The CLI prints human or JSON output and exits nonzero only for `block`.

The check path always returns `executed: false`.

## Parser Logic

`parseAction` uses a small custom tokenizer. It preserves text inside quotes,
handles simple backslash escapes, guesses `cmd`, PowerShell, or `sh`, and
redacts recognized secrets.

Recognition order is significant:

1. destructive SQL;
2. package publish;
3. Git push;
4. additional semantic actions;
5. filesystem delete;
6. fallback to `shell.generic`.

Recognized semantic actions include:

| Kind | Representative semantic IDs |
| --- | --- |
| Filesystem delete | `filesystem.delete.file`, `filesystem.delete.wildcard`, `filesystem.delete.recursive.force` |
| Git push | `git.push`, `git.push.force` |
| Destructive Git | `git.reset.hard`, `git.clean.force`, `git.branch.delete.force` |
| Package publish | `package.npm.publish`, `package.pnpm.publish`, `package.yarn.publish` |
| Secret access | `secret.access` |
| Remote script | `remote-script.execute` |
| Privilege escalation | `privilege.escalation` |
| Docker destruction | `docker.system.prune`, `docker.destructive` |
| Deploy mutation | `deploy.mutation` |
| Destructive SQL | `sql.drop-table`, `sql.truncate-table`, `sql.delete-without-where` |
| Unknown command | `shell.generic` |

Unrecognized commands fall back to `shell.generic`, risk score `0`, and an
`allow` baseline. This is an important coverage boundary.

## Target and Blast-Radius Logic

Only filesystem deletes receive detailed path expansion and classification.
Git pushes, package publishing, and SQL receive synthetic targets. Other action
kinds currently return no resolved targets.

For deletes, the resolver:

- removes recognized flag tokens;
- expands wildcard patterns with `fast-glob`;
- follows at most 100 matches per pattern;
- does not follow symbolic links;
- resolves paths against the workspace;
- detects targets outside the workspace;
- classifies target sensitivity and recoverability.

Target categories:

- `git-metadata`: `.git` and `.github`;
- `workspace-source`: `src`, `app`, and `lib`;
- `workspace-root`;
- `config`: package files, lockfiles, `.npmrc`, `tsconfig`, Vite config, `.env`;
- `dependency-tree`: `node_modules`;
- `build-output`: `dist` and `build`;
- `home`;
- `filesystem-root`;
- `normal`.

Git metadata, home paths, and filesystem roots are protected targets. Source,
config, dependency, build, workspace-root, and protected targets are sensitive.

## Risk Logic

The risk engine produces a baseline decision. Policies may strengthen it, but
neither policy engine can weaken a baseline block.

Hard blocks include:

- SQL `DROP TABLE`, `TRUNCATE TABLE`, and `DELETE FROM` without `WHERE`;
- filesystem deletes outside the workspace;
- deletes of protected targets;
- recursive or wildcard deletes against sensitive or low-recoverability
  targets;
- force pushes to `main`, `master`, or `trunk`.

Warnings include:

- SQL delete with `WHERE`;
- package publishing;
- force push to non-protected branches;
- destructive Git history operations;
- secret access;
- remote script execution;
- privilege escalation;
- destructive Docker operations;
- deployment mutations;
- broad deletes and sensitive single-target deletes.

A single normal file delete and unrecognized generic shell commands are
allowed by the baseline risk engine.

## YAML Policy Enforcement

The stable check path uses three additive layers:

1. built-in `safe-default`;
2. global file at `TERMYTE_HOME/policy.yaml` or `~/.termyte/policy.yaml`;
3. local file at `<repo>/termyte.policy.yaml`.

Rules match one or more of:

- semantic IDs, with `*` wildcard support;
- normalized command text, with exact or wildcard matching;
- resolved paths, using normalized suffix or wildcard matching.

All configured match groups in one rule must pass. For example, a rule with
both `semantic_ids` and `paths` matches only when both conditions match.

Conflicts are resolved solely by decision strength:

```text
block > ask > warn > allow
```

Source priority does not permit a local rule to weaken a built-in block.
Invalid policy files fail loading rather than being silently ignored.

The natural-language compiler recognizes a fixed set of templates for secrets,
force pushes, auth/payment paths, test deletion, package publishing,
infrastructure/deployment paths, and destructive databases. Ambiguous or
unsupported input is rejected without writing a file.

## SQLite Policy Enforcement

The execution and shell paths use `policy_state` in `.termyte/termyte.db`.
This policy is a simpler pair of semantic-ID pattern lists:

```json
{
  "block": ["filesystem.delete.wildcard"],
  "warn": ["package.*.publish"]
}
```

Evaluation order:

1. first matching block pattern returns `block`;
2. otherwise, first matching warn pattern returns `warn`, unless risk already
   returned `block`;
3. otherwise, the risk decision is used.

SQLite policy edits validate characters, reject the global `*` pattern, track
whether state was customized, and record the built-in default version.
`policies status` reports drift but never overwrites custom state. A reset is
explicit.

## How Commands Are Blocked

### Non-Executing Check

`termyte check` never executes any command. A block is represented by the
decision and exit code `1`.

### Direct Runtime

`termyte run -- <command>` analyzes first, creates a pending ledger row, and
then:

- immediately returns a blocked outcome for `block`;
- asks for interactive approval for `warn`;
- executes `allow` or approved `warn`;
- finalizes the ledger;
- calls `MemoryEngine.observe`.

`allow-once` can override warn or block except when resolved targets include
protected targets, the home directory, or a filesystem root.

### Governed Shell and Shims

`termyte shell` creates `.termyte/sessions/<uuid>/shims`, writes shim scripts
and a hash manifest, prepends the shim directory to `PATH`, starts a local
socket or named-pipe guard, and optionally installs shell hooks.

When a shimmed tool is invoked:

1. the shim calls internal `termyte _shim`;
2. `_shim` verifies local manifest integrity;
3. `_shim` requests a guard decision;
4. the guard rejects the wrong session ID, missing commands, or shim tampering;
5. the guard analyzes the command and creates a pending ledger row;
6. `block` returns without running the real executable;
7. `warn` prompts the user;
8. approved commands resolve the real executable from the original non-shim
   `PATH`;
9. the child runs with heartbeat updates;
10. the shim sends the outcome for ledger finalization and memory observation.

If the shim cannot contact the guard, it fails closed with exit code `126`.
Shell hooks also fail closed when the guard is unavailable. Stale pending shim
rows are recovered as failed records after their heartbeat becomes stale.

This mechanism is interception, not containment. A process can bypass it by
using an absolute executable path, an unshimmed tool, or another execution
mechanism.

## Operational Memory

### JSONL User Memory

`mark-safe` and `mark-unsafe` store redacted, normalized exact command patterns
in `.termyte/memory.jsonl`. New records of the same type and pattern replace
older equivalent records.

During `check`, exact unsafe matches upgrade only `allow` to `warn`. Exact safe
matches are displayed but do not weaken any decision. `policy test` explicitly
disables memory so it tests policy alone.

### SQLite Semantic Memory

The runtime `MemoryEngine` stores one aggregate row per semantic ID and
workspace. It tracks allow, warn, block, failure, and false-positive counts,
plus confidence and the most recent outcome.

Matching uses:

- same action kind and operation;
- overlap between semantic ID labels;
- boosts for exact semantic ID and exact workspace;
- a penalty for false positives.

Runtime memory matches are included in the risk narrative and ledger metadata.
They currently do not upgrade or downgrade the final runtime decision.
The legacy `_legacy-mark-safe <memory-id>` command lowers confidence and records
a false positive.

## Logging, Ledger, and Replay

The stable check log is append-only JSONL and stores the redacted command,
decision, risk band, reason, matched rules, policy sources, memory matches, and
optional agent/session environment context.

The SQLite ledger stores pending and finalized runtime records. A record
contains the redacted command, semantic ID, decision, risk, target summary,
execution status, exit code, stdout/stderr, environment variable keys, and
structured metadata. Both `raw_command` and `redacted_command` receive the
redacted value, so the original secret-bearing command is not retained.

Replay formats ledger records chronologically and correlates shell-hook and
shell-shim entries when correlation metadata is available.

## Agent Launch Logic

`termyte codex`, `termyte claude`, and `termyte run <agent>` launch supported
agents through the same governed path.
`termyte run <agent>` accepts `codex`, `claude`, and `claudecode`; the
top-level aliases cover the common agent names directly. Termyte resolves the
executable from the original `PATH`; `claudecode` can fall back to `claude`.

For Claude Code and Codex, `termyte install <agent>` writes local native hook
configuration before launch. `termyte run <agent>` verifies that hook layer so
native tool calls can route through `termyte agent hook <agent>`.

Before launch, it:

- finds the repository root;
- ensures `.termyte` JSONL state is readable and writable;
- loads YAML policy;
- creates a session ID;
- displays an `intercepted` runtime banner;
- calls `launchGovernedSession` with the resolved agent executable;
- enables the selected runtime profile's command shims and shell hooks;
- records agent launch metadata in the SQLite ledger.

Agent child commands that hit supported shims or supported shell hooks pass
through the guard before execution. This is still interception rather than
containment: absolute executable paths, direct syscalls, unshimmed tools, direct
API calls, and processes outside the inherited governed environment remain
outside Termyte's current boundary.

## MCP Gateway Logic

`termyte mcp serve` starts a stdio JSON-RPC server for agents that support
MCP. `termyte mcp install <agent>` prints a config snippet that pins
`TERMYTE_WORKSPACE` to the current repository before launching the server.

The MCP server exposes governed tools for:

- Git status, diff, commit, push, and reset
- filesystem read, write, patch, delete, and move
- shell execution
- package install, run, and audit
- policy explanation and approval requests
- replay queries
- runtime proof

Each tool call is translated into the same internal analysis pipeline:

1. parse action;
2. resolve targets where applicable;
3. analyze blast radius and risk;
4. check policy;
5. check memory;
6. allow, warn, or block;
7. execute only if safe or approved;
8. write the ledger;
9. update memory.

`termyte prove-runtime` exercises a deterministic subset of this pipeline with
known allowed and blocked outcomes. It is the fastest proof that the governed
local runtime is functioning on the current machine.

## Benchmark Logic

`termyte bench` runs the 1,200-case governance fixture through `inspectCommand`
with memory disabled. It therefore measures the stable parser, resolver, risk,
and YAML policy path without writing check logs. Cases have one strict expected
decision. Reports include accuracy, per-decision precision and recall, a
confusion matrix, false-safe rate, overblock rate, and category results.

`termyte bench --legacy` runs the 230-case compatibility fixture through
`inspectAction`, which uses the SQLite runtime policy path. Some legacy cases
permit multiple acceptable decisions. The two suites use different engines and
labeling methods, so their scores should not be combined.

## Secret Handling

`redactCommand` masks common secret-bearing flags, assignments whose keys look
secret, bearer authorization headers, and Basic authentication values.
`redactEnvKeys` stores only sorted environment variable names.

Redaction is regular-expression based. It reduces accidental secret
persistence but is not a general secret scanner.

## Failure and Safety Behavior

- Dangerous recognized actions fail closed when the decision is `block`.
- Shim and hook guard-connection failures fail closed.
- Invalid present YAML policy files fail agent preparation and checks.
- Memory-update failures do not undo an already completed runtime result; they
  are written to stderr.
- Missing optional tools are doctor warnings, not failures.
- Missing required runtime pieces or failed shim smoke checks are doctor
  failures.

## Known Gaps

- Two policy systems and two memory/log systems coexist.
- `run <agent>` is intercepted for supported shim/hook paths but is not a full
  sandbox.
- Generic shell fallback allows unknown patterns.
- Detailed target resolution is primarily for filesystem deletes.
- YAML parsing supports a constrained subset, not arbitrary YAML.
- Interception cannot guarantee full process-tree coverage.
- Ledger storage is local but not tamper resistant.
- `ask` is supported in YAML checks, but the direct runtime approval logic only
  prompts for `warn`; SQLite runtime policy does not emit `ask`.
- `mcp serve` governs Termyte-controlled tool calls, but it does not by itself
  sandbox raw agent-native tools or direct syscalls.
