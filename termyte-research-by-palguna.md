# Termyte Research

Yes. It is technically possible today.

The individual parts already exist:

- Coding agents can load persistent repository instructions through files such as `AGENTS.md`. [GitHub documentation](https://docs.github.com/en/copilot/reference/custom-instructions-support)
- Agents can search repositories, edit files, run commands, and receive test feedback. [SWE-agent paper](https://arxiv.org/abs/2405.15793)
- Sessions can be recorded as structured event streams by agent hooks and CLI output.
- Context can be supplied through prompt files, instruction files, or MCP tools.
- Git, file paths, line numbers, commands, and timestamps provide provenance.

A practical Termyte flow is:

```text
Agent session
    ↓
Capture prompts, edits, commands, results and decisions
    ↓
Store raw events with repository + commit + timestamp
    ↓
New task arrives
    ↓
Retrieve related prior work
    ↓
Check whether referenced files and facts are still current
    ↓
Return a small sourced task packet
    ↓
Agent opens exact code and continues working
```

The minimum useful packet would be:

```json
{
  "task": "Fix signup returning 401",
  "prior_decisions": [
    {
      "fact": "Browser clients must use the Supabase anon key",
      "reason": "Service keys must remain server-side",
      "source": "session:abc:event:42",
      "observed_at_commit": "31c5..."
    }
  ],
  "attempts": [
    {
      "action": "Changed the API URL",
      "result": "401 remained",
      "source": "session:abc:event:57"
    }
  ],
  "code_anchors": [
    {
      "path": "src/auth.ts",
      "line": 28,
      "commit": "31c5..."
    }
  ],
  "validation": {
    "command": "npm test",
    "last_result": "passed"
  }
}
```

The hard questions are:

- Which past information matters to the current task.
- How much context to include before it becomes noise.

This is important because recent evidence finds that unnecessary repository instructions can reduce agent success and increase cost, while exact relevant source code performs much better than summaries. [AGENTS.md evaluation](https://arxiv.org/abs/2602.11988), [coding-context study](https://arxiv.org/abs/2607.09691)

So the grounded answer is:

**Termyte is implementable, but its value is not proven merely by capturing and retrieving sessions.** The real product proof is whether its sourced prior decisions and work state improve task completion, time, or token use compared with an agent that searches the repository normally. That requires a controlled benchmark and real repeated usage.

## Identifying the Task and Providing Relevant Context

Use a two-part system:

1. Build a live description of the task.
2. Retrieve evidence using that description.

### 1. Identify the task

Do not treat “task” as one guessed sentence. Track two separate fields:

```json
{
  "requested_task": {
    "goal": "Fix signup returning 401",
    "expected_result": "A new user can sign up",
    "constraints": ["Do not expose service keys"],
    "source": "user_prompt"
  },
  "current_step": {
    "action": "Inspect Supabase authentication configuration",
    "files": ["src/auth.ts"],
    "evidence": ["401 from /auth/v1/signup"]
  }
}
```

#### Requested task

Extract it first from the strongest available source:

1. User’s latest explicit request.
2. Linked issue or ticket.
3. Accepted implementation plan.
4. Current branch or PR description.
5. Only then infer from activity.

OpenAI recommends structuring Codex prompts like GitHub issues because the prompt defines the work clearly. [How OpenAI uses Codex](https://openai.com/business/guides-and-resources/how-openai-uses-codex/)

#### Current step

Update this from observable agent activity:

- Files searched, read, or edited.
- Symbols inspected.
- Commands executed.
- Errors and stack traces.
- Current Git diff.
- Tests being run.
- Short plans or progress messages produced by the agent.

These signals tell Termyte what the agent is doing **now**, but not necessarily its final goal. Reading `src/auth.ts` means the current step concerns authentication; it does not prove the full task is “redesign authentication.”

#### Task changes

Start a new task or ask for confirmation when:

- The user explicitly changes the goal.
- A new issue or PR becomes the work target.
- The agent begins editing unrelated files without a clear link.
- The expected result changes.
- A commit closes one task and the next prompt starts another.

Do not split every tool call into a new task. Tool calls are steps inside a task.

### 2. Retrieve relevant context

Create a search query from several concrete signals:

```text
Goal: Fix signup returning 401
Terms: signup, 401, Supabase, anon key
Code anchors: src/auth.ts, createClient
Errors: POST /auth/v1/signup 401
Constraints: service keys remain server-side
```

Search stored history using:

- Exact error messages.
- File paths and symbol names.
- Issue and task language.
- Earlier decisions containing the same components.
- Previous edits to the same code.
- Failed attempts with the same observed behaviour.
- Tests and commands related to those files.

This must be hybrid retrieval. Plain semantic similarity is insufficient because coding relevance includes relationships such as implementation → test, trace → source, and edit → affected callers. Agent Retrieval Bench explicitly evaluates these workflow relationships rather than simple textual similarity. [Agent Retrieval Bench](https://agent-retrieval-bench.github.io/)

A simple initial ranking can be:

```text
relevance =
  task-language match
  + exact file/symbol match
  + error-message match
  + linked issue match
  + recency
  + confirmed-decision weight
  - stale-commit penalty
```

No complex knowledge graph is required initially. Full-text search plus structured metadata is enough to test the idea.

### 3. Return hints first

Termyte should initially return:

```text
Relevant prior work

1. Decision: Browser signup uses the Supabase anon key.
   Source: session abc, event 42
   Observed at: commit 31c5

2. Failed attempt: Changing the API URL did not remove the 401.
   Source: session abc, event 57

3. Code anchor: src/auth.ts:createClient
   Current status: file changed since the recorded session
```

The agent can then request the full event or source when needed. Anthropic recommends this “just in time” pattern: keep lightweight references and load detailed information through tools only when required. [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

This also avoids the known problem of loading too much context. ContextBench found that agents tend to retrieve more material than they actually use. [ContextBench](https://arxiv.org/abs/2602.05892)

### Minimum viable Termyte design

```text
Latest user request
        +
Current files/errors/diff
        ↓
Structured task fingerprint
        ↓
FTS search over prior decisions, attempts and events
        ↓
Rank by exact anchors, task match and freshness
        ↓
Return 3–5 sourced context hints
        ↓
Agent requests full evidence when needed
```

The important distinction is:

- **User request identifies the intended task.**
- **Agent activity identifies the current working step.**
- **Termyte combines both to retrieve context.**

Termyte should not claim it can always infer the task automatically. The realistic product is task tracking with explicit intent first and behavioural signals used to update and verify it.
