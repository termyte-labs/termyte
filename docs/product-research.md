# Product Research

Termyte's strongest market position is:

> Termyte is a local-first policy runtime for AI coding agents. It prevents
> dangerous agent actions, keeps an audit trail, and builds operational memory
> so repeated mistakes do not happen again.

## What Developers Fear

Developers are not only worried about model quality. They are worried about
runtime agency: file deletion, Git history rewrite, secret exposure, package
publishing, infra mutations, production config changes, and long sessions with
weak auditability.

Modern coding agents already edit files and run commands. That shifts the trust
question from "can it write code?" to "what can it touch, what can it execute,
and what record remains afterward?"

## Existing Tooling

- Codex hooks provide lifecycle extensibility, including `PreToolUse`,
  `PermissionRequest`, and `PostToolUse`, but coverage is bounded by supported
  tool paths and hook trust/configuration.
- Claude Code hooks expose richer lifecycle events and pre-tool deny behavior,
  but hooks still run as local commands with the user's permissions.
- GitHub Copilot enterprise guidance emphasizes governance floors, audit logs,
  model restrictions, and organization-level policy.
- Cursor emphasizes privacy and client/agent security controls, but the core
  IDE agent still needs project-level operational guardrails.
- Enterprise AI governance tools tend to focus on usage, data, compliance, and
  network controls more than local command blast radius.

Sources reviewed:

- [OpenAI Codex hooks](https://developers.openai.com/codex/hooks)
- [GitHub governing agents](https://wellarchitected.github.com/library/governance/recommendations/governing-agents/)
- [GitHub Copilot agents responsible use](https://docs.github.com/en/copilot/responsible-use/agents)
- [Cursor security](https://cursor.com/security)

## Gap Termyte Should Own

Termyte should own the local runtime gap: deterministic command/action policy,
approvals, audit logs, and memory in the developer environment before actions
hit sensitive files, Git history, deploy tools, or package registries.

The product should not lead with generic governance. It should lead with safer
agent autonomy for engineers who want agents to move faster without giving them
unbounded local power.

## MVP

OSS MVP:

- local policy engine
- Codex and Claude hook adapters
- governed MCP gateway
- action logging and replay
- `inspect`, `allow-once`, `mark-safe`
- dangerous command blocking
- honest docs and verification commands

Avoid for MVP:

- cloud sync
- dashboard
- team auth
- generic SDK
- full OS sandbox claims
- broad enterprise compliance claims

Later paid/team features can include shared policy packs, centralized audit
export, approval workflows, GitHub org integration, role-based controls, and
agent behavior analytics.

