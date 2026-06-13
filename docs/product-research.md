# Product Research

Termyte’s strongest positioning is:

> Termyte is a local-first policy runtime for AI coding agents. It prevents
> dangerous agent actions, keeps an audit trail, and builds operational memory
> so repeated mistakes do not happen again.

## What Developers Fear

The trust problem is no longer just code quality. The fear is runtime agency:
file deletion, Git history rewrite, secret exposure, package publishing, infra
mutation, production config changes, and long-lived sessions with weak
auditability.

Once agents can run tools, the question becomes:

- what can they touch?
- what can they execute?
- what gets recorded?
- what happens after the same mistake repeats?

## What Exists Already

- Codex hooks provide lifecycle extensibility and a pre-tool control surface, but
  the coverage is still bounded by supported tool paths and hook trust/config.
- Claude Code hooks expose richer lifecycle events and pre-tool deny behavior,
  but the hooks still execute as local commands with the user’s permissions.
- GitHub’s agent and Copilot governance story emphasizes policy, auditability,
  and enterprise controls, but not a small local runtime firewall.
- Cursor emphasizes privacy and security features in the editor, but the core
  agent still needs project-level operational guardrails.
- Enterprise AI governance tools tend to focus on usage, compliance, and data
  controls more than local command blast radius.

Sources reviewed:

- [OpenAI Codex hooks](https://developers.openai.com/codex/hooks)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [GitHub Copilot responsible use for agents](https://docs.github.com/en/copilot/responsible-use/agents)
- [GitHub governing agents](https://wellarchitected.github.com/library/governance/recommendations/governing-agents/)
- [Cursor security](https://cursor.com/security)

## Gap Termyte Should Own

Termyte should own the local runtime gap: deterministic command and action
policy, approvals, audit logs, and operational memory in the developer
environment before actions hit sensitive files, Git history, deploy tools, or
package registries.

The product should lead with safer agent autonomy for engineers who want agents
to move faster without giving them unbounded local power.

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
