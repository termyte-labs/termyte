Termyte: Experience Layer for Coding Agents

Status

Version: MVP

Target: Individual developers using Codex and Claude Code

Delivery: Local-first CLI

Product Summary

Termyte observes coding-agent sessions, learns reusable lessons from outcomes, and automatically applies relevant experience to future tasks.

Promise: Every session makes your coding agents better at your project.

Problem

Coding agents repeatedly rediscover project knowledge, repeat failed approaches, ignore established patterns, and require the same developer corrections.

Existing memory tools retain facts and conversations. They do not reliably convert completed work, failures, tests, and corrections into experience that changes future agent behaviour.

Target User

An individual developer who:

Uses Codex, Claude Code, or both daily.

Works repeatedly in the same repositories.

Delegates multi-step implementation and debugging tasks.

Frequently corrects agents or watches them repeat investigations.

Core Job

When I give a coding agent a task, use what previous agents learned in this project so it completes the task with less supervision and wasted work.

Product Principles

Automatic: developers do not manually save memories.

Outcome-focused: learn from results, not statements alone.

Cross-agent: experience created by one agent helps another.

Local-first: raw sessions and stored experience remain local.

Evidence-linked: preserve the session, files, commands, Git state, and tests behind each lesson.

Invisible workflow: developers continue using their existing coding agents normally.

MVP User Experience

Installation

npx termyte init

Termyte detects supported agents, installs hooks, initializes SQLite, and confirms capture with no required account.

During a Session

Termyte captures:

User prompts.

Tool calls and outputs.

Files read and changed.

Commands and test results.

Agent responses.

Git branch, commit, and working-tree state.

Common secrets are redacted before persistence.

After a Session

An LLM reflects on the session and writes one concise experience record containing:

What future agents should learn.

What worked or failed.

Developer corrections.

Reusable project patterns.

Supporting evidence.

Unfinished or uncertain conclusions.

The output must not claim success without evidence.

At the Start of a New Session

Before the agent begins work, Termyte automatically injects a project briefing containing:

What the repository does and how it is structured.

Recent and unfinished tasks.

Important decisions and constraints.

Relevant successful and failed approaches.

Current Git branch, commit, and working-tree state.

Known build, test, and verification workflows.

The briefing is compiled from previous sessions, stored experience, and current repository state.

At Every Prompt

When a user submits a prompt, Termyte:

Sends the current request, project briefing, and compact experience catalogue to an LLM.

Asks the LLM to identify helpful context for this specific request.

Loads supporting session evidence when needed.

Compiles a short request-specific context packet.

Injects it before the agent handles the prompt.

The briefing may include:

Applicable project patterns.

Relevant previous implementations.

Failed assumptions to avoid.

Developer preferences and corrections.

Important constraints.

Likely files and commands.

Recommended verification.

Learning Loop

Observe -> Reflect -> Store -> Apply -> Observe outcome

Termyte does not train model weights. It enables project-specific learning through external experience supplied at inference time.

Functional Requirements

Capture

Support Claude Code and Codex hooks.

Associate sessions with a canonical repository identity.

Store sanitized raw events in SQLite.

Avoid capturing Termyte's own internal LLM calls recursively.

Reflection

Generate one experience after each meaningful session.

Use the developer's existing supported agent when possible.

Keep experience compact and understandable.

Link every experience to its source session.

Application

Generate a broad project briefing automatically at every new session.

Generate relevant context automatically at every user prompt.

Consider experience from all repository sessions without vector search or embeddings.

Use LLM reasoning over compact session and experience summaries for selection.

Prefer evidence-backed and recent information when conflicts exist.

Keep both session and prompt context within configurable token limits.

Do not block the coding agent when context generation fails.

Minimal Data Model

CREATE TABLE experiences (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence TEXT,
  created_at TEXT NOT NULL
);

Existing session and event tables remain authoritative raw history.

Non-Goals for MVP

Model training or fine-tuning.

Cloud synchronization.

Team workspaces and permissions.

Slack, Jira, Linear, or email integrations.

Embeddings, vector retrieval, or knowledge graph.

Complex memory taxonomy.

Dashboard or standalone chat interface.

Support for every coding agent.

Guaranteed detection of every secret.

Success Metrics

Compare identical repository tasks with and without Termyte:

Higher task-completion rate.

More passing verification tests.

Fewer developer corrections.

Fewer repeated failed approaches.

Lower completion time and tool usage.

Relevant experience changes the agent's chosen approach.

Recall accuracy alone is not a success metric.

Launch Demo

Claude Code attempts a task and receives a developer correction or test failure.

Termyte extracts the reusable lesson.

Codex receives a related task in a fresh session.

Termyte injects the relevant experience automatically.

Codex applies the correction or avoids the failed approach.

The final verification passes.

Launch Copy

Headline: Every session makes your coding agents better.

Subheadline: Termyte learns from what works, fails, and gets corrected in your project, then applies that experience across Codex and Claude Code.

MVP Acceptance Criteria

One-command installation works on the primary supported platform.

Sessions from Claude Code and Codex are captured locally.

Meaningful sessions produce an experience record.

Every new session receives an automatic project briefing.

The briefing includes previous tasks, repository information, Git state, and useful project experience.

Every prompt receives short, request-specific context when relevant.

Context can use experience from any earlier project session.

Cross-agent demo succeeds without manual handoff text.

Failure in Termyte never prevents the coding agent from running.