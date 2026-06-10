You are operating in GOAL MODE on the Termyte codebase.

Termyte is intended to be a local-first policy runtime for AI coding agents. The current product is not working properly. Your job is to make it work end-to-end, while also doing parallel product/market research to shape the runtime into the best possible agent-safety product.

I have added two important files:

* `codex-hook-docs.md`
* `claude-hook-docs.md`

Read them carefully first. They are the source of truth for how Codex and Claude Code hooks should work.

Your mission is to turn Termyte into a working MVP runtime that can safely sit between coding agents and the developer environment.

You may create subagents internally if useful. Split the work into parallel tracks, then merge the findings into implementation decisions.

## Core thesis

Developers do not fully trust autonomous coding agents because agents can:

* delete files
* rewrite git history
* expose secrets
* publish packages
* break production config
* run destructive shell commands
* touch infra/deployment files
* forget previous mistakes
* hallucinate during long coding sessions
* operate without reliable audit trails

Termyte should solve this by becoming the local-first runtime layer that gives coding agents policies, approvals, memory, and auditability.

## Core objective

Make Termyte a working local-first policy runtime for AI coding agents.

The product is not just a hook installer.

The product is:

1. policy engine
2. agent integration layer
3. runtime enforcement layer
4. approval system
5. operational memory
6. audit log
7. CLI developer UX

Treat the policy engine as the core product primitive. Agent integrations are the distribution layer, but policies, approvals, memory, and audit logs are the actual runtime.

## Important constraint

Do not just patch random files.

First understand the current architecture.

Before coding:

1. Inspect the repository structure.
2. Read the README, package files, CLI entrypoints, runtime files, policy files, tests, and the two new hook docs.
3. Identify what currently exists.
4. Identify what is broken.
5. Identify what is missing.
6. Identify what should be deleted or simplified.
7. Create a clear implementation plan.
8. Then execute.

Do not leave the repo in a broken state.

## Work model

Use subagents or parallel workstreams if useful.

You should split the work into these tracks:

1. Runtime Architecture Agent
2. Codex Integration Agent
3. Claude Code Integration Agent
4. Policy System Agent
5. Operational Memory Agent
6. Developer UX Agent
7. Market Research / Product Strategy Agent
8. Testing / Verification Agent
9. Documentation Agent

Each track should produce decisions or implementation changes. Then merge everything into one working product.

Do not let research block implementation. Product research should run in parallel and feed into product decisions.

---

# Phase 0: Repository understanding

Before implementation, inspect the repo.

Check:

* `package.json`
* `tsconfig.json`
* CLI entrypoints
* source folders
* tests
* policy files
* memory/database files
* hook installation code
* Codex integration code
* Claude integration code
* README
* docs
* benchmark files
* config examples
* `codex-hook-docs.md`
* `claude-hook-docs.md`

Then produce a short internal diagnosis:

1. What Termyte currently does.
2. What is broken.
3. What is fake/incomplete.
4. What can be preserved.
5. What must be rewritten.
6. What the MVP should be.

Then start implementation.

---

# Runtime Architecture Agent

Goal: figure out the best architecture for Termyte.

Answer and then implement:

* Should Termyte work as hooks, shell wrapper, MCP server, command shim, daemon, SDK, or a combination?
* What should be MVP now?
* What should be future roadmap?
* What is the cleanest architecture that works across Codex, Claude Code, and future coding agents?
* What are the boundaries between:

  * agent integration
  * command/action normalization
  * policy engine
  * risk scoring
  * approval system
  * operational memory
  * audit logs
  * CLI UX

Expected architecture direction:

Termyte should have a core runtime package/module that does not care whether the action came from Codex, Claude, shell shim, or future agents.

Suggested internal flow:

```txt
Agent / Hook / CLI / Shim
        ↓
Action adapter
        ↓
RuntimeAction normalization
        ↓
Signal extraction
        ↓
Policy loading
        ↓
Policy evaluation
        ↓
Approval/memory check
        ↓
Decision: allow / warn / block
        ↓
Audit log + memory write
        ↓
Hook-compatible response / CLI output / process exit
```

The implementation should separate:

* integrations from core logic
* policies from CLI
* memory from policy rules
* hook adapters from action evaluation
* docs from product claims

---

# Codex Integration Agent

Goal: make Termyte work with Codex.

Use `codex-hook-docs.md` as the source of truth.

Tasks:

* Understand Codex hook capabilities and limitations.
* Identify where Termyte should plug into Codex.
* Implement or fix `termyte install codex`.
* Implement or fix `termyte run codex`.
* Ensure Codex actions can be inspected, warned, blocked, or logged depending on what hooks allow.
* If full blocking is not possible through hooks alone, clearly document the limitation.
* If hooks are not enough for real blocking, implement the strongest reliable fallback path.
* Add tests or smoke tests for Codex integration.

Expected behavior:

```bash
termyte install codex
```

Should:

* install required hook config
* avoid overwriting user config without backup
* print exactly what changed
* show where hooks were installed
* explain next steps

```bash
termyte run codex
```

Should:

* launch Codex if available
* activate Termyte protection
* pass required environment variables
* connect hook events to the policy engine
* log sessions
* show a clear startup banner
* fail gracefully if Codex is missing

If true pre-execution blocking is not supported by Codex hooks, say so honestly in docs and use a shim/shell fallback where possible.

---

# Claude Code Integration Agent

Goal: make Termyte work with Claude Code.

Use `claude-hook-docs.md` as the source of truth.

Tasks:

* Understand Claude Code hook capabilities and limitations.
* Implement or fix `termyte install claude`.
* Implement or fix `termyte run claude`.
* Ensure Claude Code actions can be inspected, warned, blocked, or logged depending on what hooks allow.
* If Claude supports stronger pre-tool blocking than Codex, use that.
* Add tests or smoke tests for Claude integration.

Expected behavior:

```bash
termyte install claude
```

Should:

* install required hook config
* avoid overwriting user config without backup
* print exactly what changed
* show where hooks were installed
* explain next steps

```bash
termyte run claude
```

Should:

* launch Claude Code if available
* activate Termyte protection
* pass required environment variables
* connect hook events to the policy engine
* log sessions
* show a clear startup banner
* fail gracefully if Claude Code is missing

Do not pretend Codex and Claude have identical control surfaces if they do not.

---

# Policy System / Rules Engine Agent

Goal: design and implement the core Termyte policy system properly.

This is one of the most important parts of the product. Termyte should not just hardcode random command checks. It needs a simple, local-first, extensible policy system that can grow from individual developer usage to team/enterprise usage later.

## Policy design requirements

Design policies around these concepts:

## 1. Action

An action is what the agent is trying to do.

Examples:

* shell command
* file read
* file write
* file delete
* git operation
* package manager operation
* network request
* database operation
* environment/secrets access
* deployment operation
* CI/CD config modification

Each action should be normalized into a structured internal shape.

Example shape:

```ts
type RuntimeAction = {
  kind: "shell" | "file" | "git" | "package" | "network" | "database" | "secret" | "unknown";
  raw: string;
  command?: string;
  args?: string[];
  cwd?: string;
  targetFiles?: string[];
  agent?: "codex" | "claude" | "unknown";
  sessionId?: string;
  repoRoot?: string;
  timestamp: string;
};
```

Do not over-engineer this, but create enough structure so policies are not just fragile string matching.

## 2. Decision

Every policy evaluation must return a clear decision:

```ts
type PolicyDecision = {
  outcome: "allow" | "warn" | "block";
  risk: "low" | "medium" | "high" | "critical";
  ruleId: string;
  reason: string;
  matchedSignals: string[];
  suggestedFix?: string;
};
```

Examples:

* `allow`: safe local read/test/build action
* `warn`: dependency install, migration, large file edit, network request
* `block`: `rm -rf`, force push to main, secret exfiltration, destructive DB command

## 3. Policy levels

Implement policy levels.

Termyte should support at least:

```yaml
mode: standard
```

Valid modes:

* `off`
* `observe`
* `standard`
* `strict`
* `paranoid`

Behavior:

### off

Termyte does nothing except maybe print that protection is disabled.

### observe

Termyte never blocks. It only logs what would have happened.

Useful for first-time users who want to see what agents are doing.

### standard

Default mode.

* allow safe actions
* warn medium-risk actions
* block obvious destructive actions

### strict

For serious projects.

* block high-risk actions
* require approval for medium-risk actions
* warn on large file changes, dependency changes, CI/CD changes, network calls

### paranoid

For production repos or sensitive codebases.

* block secrets access
* block package publishing
* block deploy commands
* block force pushes
* require approval for dependency installs
* require approval for migrations
* require approval for deleting files
* require approval for network calls
* require approval for touching `.github`, Docker, infra, env, lockfiles

## 4. Policy sources

Policies should come from multiple layers, in this priority order:

1. built-in Termyte default policies
2. global user policy file
3. project-level policy file
4. temporary session approvals
5. `allow-once`
6. `mark-safe` memory overrides

Suggested files:

Global:

```bash
~/.termyte/policies.yaml
```

Project:

```bash
./termyte.yaml
```

Local memory/database:

```bash
~/.termyte/memory.sqlite
```

Policy precedence:

* project policy overrides global policy
* explicit blocks beat allows
* temporary approvals expire after use or after TTL
* `allow-once` only applies to one exact command fingerprint
* `mark-safe` should reduce warning noise but should never override critical blocks unless explicitly configured

## 5. Project policy file

Create or support a `termyte.yaml` file.

Example:

```yaml
version: 1

mode: standard

protectedBranches:
  - main
  - master
  - production

protectedPaths:
  - .env
  - .env.*
  - .git/**
  - .github/**
  - package-lock.json
  - pnpm-lock.yaml
  - yarn.lock
  - Dockerfile
  - docker-compose.yml
  - infra/**
  - terraform/**
  - migrations/**

secrets:
  blockRead:
    - .env
    - .env.local
    - .env.production
    - id_rsa
    - "*.pem"
    - "*.key"

commands:
  block:
    - "rm -rf *"
    - "rm -rf /"
    - "git push --force origin main"
    - "git push --force origin master"
    - "npm publish"
    - "pnpm publish"
    - "yarn publish"
    - "DROP TABLE"
    - "TRUNCATE TABLE"

  warn:
    - "npm install"
    - "pnpm install"
    - "yarn add"
    - "pip install"
    - "docker build"
    - "docker compose up"
    - "prisma migrate"
    - "alembic upgrade"
    - "curl * | bash"
    - "wget * | sh"

allow:
  commands:
    - "npm test"
    - "npm run test"
    - "npm run build"
    - "npm run typecheck"
    - "git status"
    - "git diff"
    - "git log"

approvals:
  requireFor:
    - dependency-change
    - migration
    - package-publish
    - deploy
    - force-push
    - secret-access
    - protected-path-edit

memory:
  enabled: true
  warnOnRepeatedRisk: true
  rememberApprovals: true
  approvalTTLMinutes: 30
```

Implement a simpler version if needed, but design it so this config can work eventually.

## 6. Built-in policy rules

Implement built-in rule IDs.

Minimum required rules:

```txt
git.push.force.protected_branch
git.push.force.any
git.branch.delete
git.reset.hard
file.delete.recursive
file.delete.git_dir
file.delete.source_dir
file.delete.protected_path
file.modify.protected_path
secret.read.env
secret.read.private_key
secret.possible_exfiltration
package.publish
package.install
package.manifest.modify
package.lockfile.modify
db.drop
db.truncate
db.delete_without_where
network.curl_pipe_shell
network.wget_pipe_shell
infra.modify
ci.modify
docker.modify
migration.run
deploy.command
permission.chmod_recursive_777
sudo.destructive
unknown.high_entropy_command
```

Each rule should include:

* rule ID
* severity
* default action
* explanation
* matched signals
* suggested safer alternative

Example:

```ts
{
  id: "git.push.force.protected_branch",
  severity: "critical",
  defaultOutcome: "block",
  reason: "Force pushing to a protected branch can rewrite shared history.",
  suggestedFix: "Create a new branch or use a normal push after review."
}
```

## 7. Risk scoring

Add a simple risk scoring layer.

Risk should consider:

* command type
* target path
* git branch
* file count touched
* whether secrets are involved
* whether network is involved
* whether command is destructive
* whether action affects package/deploy/infra
* whether action has happened before
* whether user approved similar action before
* whether current repo has stricter config

Example scoring:

```ts
type RiskScore = {
  score: number; // 0-100
  level: "low" | "medium" | "high" | "critical";
  signals: string[];
};
```

Suggested mapping:

* 0-24: low
* 25-49: medium
* 50-79: high
* 80-100: critical

Do not let scoring replace hard rules. Critical hard rules should still block.

## 8. Approval system

Implement approval primitives.

Commands:

```bash
termyte allow-once "<command>"
termyte mark-safe "<command>"
termyte inspect "<command>"
```

Behavior:

### allow-once

* creates a fingerprint for the command
* stores one-time approval
* expires after use or TTL
* logs approval
* should not allow critical commands unless user passes `--force`

Example:

```bash
termyte allow-once "npm install zod"
```

### mark-safe

* records that this command pattern is safe in this repo
* reduces future warnings
* should not override critical blocks
* should be repo-scoped by default

Example:

```bash
termyte mark-safe "npm run build"
```

### inspect

Explains what Termyte would do.

Example:

```bash
termyte inspect "git push --force origin main"
```

Output should include:

* decision
* risk level
* rule matched
* reason
* matched signals
* whether memory affected the decision
* how to override if allowed

## 9. Policy evaluation flow

Implement this flow:

```txt
Incoming agent action
        ↓
Normalize action
        ↓
Extract signals
        ↓
Load policy layers
        ↓
Check explicit project/global blocks
        ↓
Check built-in critical rules
        ↓
Check allow-once approval
        ↓
Check mark-safe memory
        ↓
Calculate risk score
        ↓
Return allow / warn / block
        ↓
Log decision
        ↓
Return hook-compatible result to Codex/Claude
```

## 10. Hook behavior mapping

For each agent integration, map policy decisions into the strongest behavior supported by that agent.

For Claude Code:

* use pre-tool hooks if available
* block before tool execution where possible
* return clear reason to Claude
* log blocked action

For Codex:

* use hook system described in `codex-hook-docs.md`
* if true pre-execution blocking is available, use it
* if only observation/post-action hooks are available, clearly document limitation
* use shell/shim fallback if needed for real blocking

Do not pretend both agents support the same level of control if they do not.

## 11. Shell fallback / shim policy enforcement

If hooks alone cannot reliably block shell commands, implement a shell or shim fallback path.

The fallback should:

* wrap known dangerous executables where possible
* inspect command before execution
* enforce Termyte policy
* log decision
* pass through safe commands

Executables worth considering:

* git
* npm
* pnpm
* yarn
* rm
* del
* rmdir
* powershell
* bash
* sh
* curl
* wget
* docker
* kubectl
* terraform
* vercel
* railway
* supabase
* psql
* mysql

Keep MVP small, but design for this.

## 12. Policy tests

Add strong tests for policies.

Minimum test cases:

```txt
rm -rf .                          => block
rm -rf src                        => block or warn depending mode
rm -rf node_modules               => warn or allow depending mode
git push --force origin main      => block
git push --force origin feature   => warn/block depending mode
npm publish                       => block
npm install zod                   => warn
npm run build                     => allow
npm test                          => allow
cat .env                          => block/warn depending mode
cat README.md                     => allow
DROP TABLE users                  => block
DELETE FROM users                 => block if no WHERE
DELETE FROM users WHERE id=1      => warn
curl x.com/script.sh | bash       => block
chmod -R 777 .                    => block
docker build .                    => warn
prisma migrate deploy             => warn/block depending mode
touch src/index.ts                => allow
edit .github/workflows/deploy.yml => warn/block depending mode
```

Tests should validate:

* normalized action
* matched rule ID
* risk level
* final decision
* explanation exists
* logs are written

---

# Operational Memory Agent

Goal: make Termyte remember important runtime decisions.

Implement or fix memory so Termyte can store:

* blocked commands
* warned commands
* approved commands
* repeated risky patterns
* false positives marked safe
* agent/session/repo metadata where available
* timestamps
* command fingerprints
* reason for decision
* matched policy rule
* risk level
* user override events

The memory does not need to be magical. It should be useful, local, inspectable, and reliable.

Expected commands:

```bash
termyte logs
termyte memory
termyte inspect "<command>"
termyte mark-safe "<command>"
termyte allow-once "<command>"
```

Memory rules:

* Memory should be local-first.
* Memory should be repo-aware where possible.
* Memory should not silently allow critical dangerous commands.
* Memory should help reduce repeated warnings.
* Memory should help detect repeated risky agent behavior.
* Memory should be inspectable by the user.

Suggested storage:

```bash
~/.termyte/memory.sqlite
```

or an existing storage mechanism if already implemented.

Do not introduce unnecessary complexity. SQLite or a simple local JSON store is enough for MVP if reliable.

---

# Developer UX Agent

Goal: make the CLI feel like a real product.

Expected commands:

```bash
termyte doctor
termyte install codex
termyte install claude
termyte run codex
termyte run claude
termyte logs
termyte memory
termyte policies
termyte inspect "<command>"
termyte allow-once "<command>"
termyte mark-safe "<command>"
termyte bench
```

The CLI should clearly explain:

* what is protected
* what is not protected
* whether hooks are installed
* whether runtime is active
* where logs are stored
* what policy mode is active
* what agent is being protected
* what action was blocked/warned/allowed
* why the decision happened
* how to safely override if possible
* what limitations exist

The product should never falsely claim OS sandboxing if it does not provide it.

## `termyte doctor`

Should check:

* Node version
* OS
* current repo
* Termyte config
* global policy file
* project policy file
* memory database
* hook installation status
* Codex hook status
* Claude hook status
* executable availability
* known limitations

## `termyte inspect`

Example:

```bash
termyte inspect "git push --force origin main"
```

Should output:

```txt
Decision: BLOCK
Risk: CRITICAL
Rule: git.push.force.protected_branch
Reason: Force pushing to a protected branch can rewrite shared history.
Signals: git, force-push, protected-branch, main
Suggested fix: Create a new branch or use a normal push after review.
```

## `termyte policies`

Should show:

* active mode
* project policy path
* global policy path
* protected branches
* protected paths
* important built-in rules
* whether memory overrides are enabled

---

# Market Research / Product Strategy Agent

Run product research from inside the repository context.

Research the market conceptually and, if internet access is available, use it.

Answer:

* What are developers actually afraid of when using coding agents?
* What do products like Claude Code, Codex, Cursor, Devin, GitHub Copilot, and enterprise AI governance tools already provide?
* What gap should Termyte own?
* Should Termyte position as:

  * safety runtime for coding agents
  * local-first agent firewall
  * operational memory for coding agents
  * policy engine for autonomous coding agents
  * runtime for safe agent execution
* What should be OSS?
* What should be paid later?
* What features matter for individual developers now?
* What features matter for teams later?
* What should the MVP avoid?

Produce a concise file:

```txt
docs/product-research.md
```

or:

```txt
PRODUCT_RESEARCH.md
```

The research should be practical, not academic.

Focus on:

* current agent adoption pain
* developer trust
* command safety
* local-first enforcement
* audit logs
* memory
* team policies
* why existing tools do not fully solve this

## Product direction

The MVP positioning should likely be:

```txt
Termyte is a local-first policy runtime for AI coding agents. It prevents dangerous agent actions, keeps an audit trail, and builds operational memory so repeated mistakes do not happen again.
```

But validate this against the code and research.

## Product layers

Think of Termyte in levels:

### Level 1: Individual developer / OSS MVP

Must include:

* local policy engine
* Codex integration
* Claude Code integration
* action logging
* inspect command
* allow-once
* mark-safe
* dangerous command blocking
* clear docs

### Level 2: Power user / serious repo

Should include later:

* stricter project policies
* protected paths
* repo-specific memory
* policy packs
* better shell/shim coverage
* benchmarks
* configurable modes

### Level 3: Team / paid product

Should include later:

* shared team policies
* centralized audit logs
* approval workflows
* managed policy packs
* GitHub org/repo integration
* role-based permissions
* compliance export
* cloud dashboard
* agent behavior analytics

Do not build Level 3 now. Design the local core so Level 3 is possible later.

---

# Testing / Verification Agent

Goal: make sure the repo actually works.

Implementation priorities:

## Phase 1: Make the project build

* Run install/build/test.
* Fix TypeScript errors.
* Fix broken imports.
* Fix CLI entrypoints.
* Fix package scripts.
* Ensure `npm run build` works.
* Ensure tests run or document exactly why they do not.

## Phase 2: Policy tests

Add tests for:

* command normalization
* signal extraction
* policy decisions
* risk scoring
* project config loading
* built-in rules
* allow-once
* mark-safe
* inspect output
* memory logging

## Phase 3: Hook tests

Add tests or smoke tests for:

* Codex hook payload parsing
* Claude hook payload parsing
* hook decision mapping
* blocked command response
* warned command response
* allowed command response
* missing executable behavior
* install config backup behavior

## Phase 4: CLI tests

Add tests or smoke tests for:

* `termyte doctor`
* `termyte policies`
* `termyte inspect`
* `termyte logs`
* `termyte memory`
* `termyte allow-once`
* `termyte mark-safe`
* `termyte install codex`
* `termyte install claude`

Do not fake tests. If full integration tests are not possible, create deterministic smoke tests and document limitations.

---

# Documentation Agent

Create or update:

```txt
README.md
docs/architecture.md
docs/product-research.md
docs/policies.md
docs/policy-modes.md
docs/approvals.md
docs/codex-integration.md
docs/claude-integration.md
docs/limitations.md
docs/examples/termyte.yaml
```

Docs must be honest.

Do not claim:

* OS sandboxing
* perfect security
* enterprise governance
* complete agent control
* guaranteed prevention
* cloud policy management

unless actually implemented.

Docs should explain:

* what Termyte protects
* what Termyte does not protect
* how Codex integration works
* how Claude integration works
* how policies work
* how approval works
* how memory works
* how to install
* how to verify
* how to uninstall or disable
* known limitations
* roadmap

---

# Implementation priorities

Use this order:

## Phase 1: Make the repo build

Run:

```bash
npm install
npm run build
npm test
```

Fix what breaks.

## Phase 2: Make core policy engine real

Implement:

* RuntimeAction normalization
* signal extraction
* built-in rules
* risk scoring
* policy evaluation
* decision object
* tests

## Phase 3: Make memory/audit real

Implement:

* local decision logging
* blocked/warned/allowed events
* command fingerprints
* allow-once
* mark-safe
* inspect
* logs
* memory command

## Phase 4: Make doctor useful

Implement:

```bash
termyte doctor
```

It must show real system status, not fake green checks.

## Phase 5: Make hooks install

Implement:

```bash
termyte install codex
termyte install claude
```

Use `codex-hook-docs.md` and `claude-hook-docs.md`.

## Phase 6: Make runtime execution work

Implement:

```bash
termyte run codex
termyte run claude
```

It should:

* launch the right agent
* activate Termyte runtime
* connect hooks to policy engine
* log session
* fail gracefully if agent missing

## Phase 7: Add docs and product research

Write concise useful docs.

## Phase 8: Final verification

Run the verification commands and report results honestly.

---

# Non-negotiables

* Do not leave the repo broken.
* Do not make fake claims.
* Do not add huge unnecessary dependencies.
* Do not build cloud features right now.
* Do not build a full OS sandbox right now.
* Do not build a complex UI right now.
* Do not over-abstract before the MVP works.
* Prefer simple, working, testable code.
* Preserve existing useful code where possible.
* Remove or isolate dead code if it blocks the product.
* Every major change should have a reason.
* Do not silently ignore failing tests.
* Do not mark incomplete features as done.
* Do not claim Codex/Claude support if the integration is only partially working.
* Do not hide limitations.
* Do not build a toy demo. Build the first usable version.

---

# Required final output

When finished, provide:

1. Summary of what was broken.
2. Summary of what was fixed.
3. Final architecture of the runtime.
4. How the policy engine works.
5. How Codex integration works.
6. How Claude integration works.
7. How approvals work.
8. How memory/audit logs work.
9. What commands now work.
10. What tests were added or fixed.
11. What market/product research concluded.
12. What docs were created or updated.
13. What limitations still exist.
14. Exact commands I should run to verify everything locally.
15. Any files that need manual review.

---

# Verification commands

At minimum, make these pass or explain exactly why they cannot pass:

```bash
npm install
npm run build
npm test
termyte doctor
termyte policies
termyte inspect "git push --force origin main"
termyte inspect "npm install zod"
termyte inspect "npm run build"
termyte allow-once "npm install zod"
termyte mark-safe "npm run build"
termyte logs
termyte memory
termyte install codex
termyte install claude
termyte run codex
termyte run claude
termyte bench
```

---

# Final mindset

Act like a founding engineer building the first usable version of Termyte.

The goal is not to make a pretty demo.

The goal is to make the runtime actually work, make the agent integrations real, make the safety layer useful, and make the product direction obvious.

Ship the smallest serious version that proves Termyte can become the policy runtime for autonomous coding agents.
