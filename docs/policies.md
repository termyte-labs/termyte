# Policies

Termyte policy evaluation starts with built-in rules and can be extended with
local policy files and repo-scoped memory.

Current policy sources:

- built-in semantic rules in the CLI/runtime
- global Phase 1 policy file at `~/.termyte/policy.yaml`
- project Phase 1 policy file at `./termyte.policy.yaml`
- project compatibility policy file at `./termyte.yaml` when `./termyte.policy.yaml` is absent
- SQLite policy state used by the legacy `termyte policies` command
- one-time approvals in `.termyte/approvals.json`
- repo memory in `.termyte/memory.jsonl` and `.termyte/termyte.db`

When multiple policy inputs match, the safer decision wins:

```text
block > ask > warn > allow
```

Policy files use this shape:

```yaml
version: 1
mode: standard
presets: []
rules:
  - name: warn-auth-edits
    action: warn
    match:
      paths:
        - "src/auth/**"
```

Supported matchers are `semantic_ids`, `commands`, and `paths`.

`termyte.yaml` is the user-facing project config shape. The current runtime
loads these fields and converts them into Phase 1 policy rules:

```yaml
version: 1
mode: standard
protectedPaths:
  - src/auth/**
secrets:
  blockRead:
    - .env
commands:
  block:
    - "npm publish"
  warn:
    - "npm install"
allow:
  commands:
    - "npm test"
```

`protectedBranches`, `approvals`, and `memory` are accepted for compatibility
and reported as warnings by `termyte policy show`, but their settings are not
yet separate policy inputs. Branch protection, approvals, and memory still use
the built-in runtime behavior.

## Built-In Coverage

The current parser and risk engine recognize destructive filesystem deletes,
force pushes, destructive Git operations, package installs and publishing,
secret reads, remote script execution, privilege escalation, Docker destructive
commands, deployment mutations, and destructive SQL.

Package publishing is blocked by default. Dependency installation is warned by
default because it changes manifests, lockfiles, or the local dependency graph
but is a common development action.

Unrecognized commands fall back to `shell.generic`; that is a coverage boundary,
not proof that the command is safe.
