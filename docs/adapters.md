# Adapter development

Termyte is built to be extended. There are two kinds of adapters and they live in different parts of the code:

| Adapter | Purpose | Files |
|---|---|---|
| `PlatformAdapter` (capture) | Normalize a specific agent's hook payload into `NormalizedEvent`. | `src/capture/<agent>.ts` |
| `AgentAdapter` (synthesis) | Invoke a specific agent's LLM for one-shot synthesis. | `src/synth/<agent>.ts` |

Most agents need both. A few (Cursor, Windsurf) only need a capture adapter because they can't drive an LLM programmatically. A few (Copilot CLI, Antigravity, etc.) need neither — they're MCP-only.

## Adding a new capture adapter

A capture adapter is the only thing that knows about a specific agent's hook protocol. It normalizes the agent's raw payload into the shared `NormalizedEvent` and re-wraps termyte's `HookResult` into the agent's response envelope.

### 1. Implement the interface

```ts
// src/capture/my-agent.ts
import type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
import { isObject, pickString } from "./util.js";
import { AdapterRejectedInput, isValidCwd } from "./errors.js";

export class MyAgentAdapter implements PlatformAdapter {
  readonly name = "my-agent" as const;

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    const session_id = pickString(r, ["session_id", "sessionId", "id"]);
    if (!session_id) return null;

    const cwd = pickString(r, ["cwd"]) ?? process.cwd();
    if (!isValidCwd(cwd)) throw new AdapterRejectedInput("invalid_cwd");

    // ... extract event_type, tool_name, tool_input, tool_output, files_read,
    // files_modified, user_prompt, final_response from `r` ...

    return {
      session_id,
      timestamp: typeof r["timestamp"] === "number" ? r["timestamp"] as number : Date.now(),
      event_type,
      tool_name,
      tool_input,
      tool_output,
      files_read,
      files_modified,
      user_prompt,
      final_response,
      cwd,
    };
  }

  formatOutput(result: HookResult): unknown {
    return { continue: result.continue ?? true };
  }
}
```

Key conventions:

- `normalize()` returns `null` for unparseable inputs. The hook driver treats this as a no-op and exits 0.
- `normalize()` throws `AdapterRejectedInput` for inputs the agent did send but that we reject (e.g. a `cwd` outside the workspace). The driver logs to stderr and exits non-zero.
- `cwd` is **not** persisted in the trace, but it's used by the runner to detect `repo_id` and `workspace_root`.
- File paths should be absolute and use forward slashes.

### 2. Register the platform

Add the platform id to the `Platform` type in `src/core/types.ts`:

```ts
export type Platform = "claude-code" | "codex" | "opencode" | "cursor" | "gemini-cli" | "windsurf" | "raw" | "my-agent";
```

Add the adapter to the `adapterFor` switch in `src/capture/index.ts`:

```ts
case "my-agent": return new MyAgentAdapter();
```

Re-export the class from `src/capture/index.ts` if you want it available to programmatic users.

### 3. Add tests

Add a test file under `test/adapters.test.ts` (or create a new file if the adapter is large). At minimum:

- A `normalize()` happy path with a sample agent payload.
- A `normalize()` that returns `null` for a malformed payload.
- A `normalize()` that throws `AdapterRejectedInput` for an out-of-workspace cwd.
- A `formatOutput()` round-trip.

Use the same Vitest patterns as the existing tests.

### 4. Write the installer

The installer writes the agent's hook config. The shape of the config depends on the agent — see the existing installers for the patterns:

| Agent | File | Notes |
|---|---|---|
| Claude Code | `src/integrations/installers/claude-code.ts` | Writes `~/.claude/settings.json`. Bakes the absolute path to `termyte-hook`. |
| Codex | `src/integrations/installers/codex.ts` | Writes `~/.codex/hooks.json`. |
| Cursor | `src/integrations/installers/cursor.ts` | Writes `~/.cursor/hooks.json`. |
| Gemini | `src/integrations/installers/gemini.ts` | Writes `~/.gemini/settings.json`. |
| Windsurf | `src/integrations/installers/windsurf.ts` | Writes `~/.codeium/windsurf/hooks.json`. |
| OpenCode | `src/integrations/installers/opencode.ts` | Copies the plugin into `~/.config/opencode/plugins/`. |

The installer MUST call `backupIfExists()` from `src/integrations/installers/backup.ts` before overwriting any pre-existing config — this is non-negotiable, it protects the user from accidental destruction of their own settings.

Register the installer in `src/integrations/installers/index.ts`:

```ts
case "my-agent": return installMyAgentHooks({ target, homeDir: home });
```

Add the platform id to `SupportedPlatform` and `listSupportedPlatforms()`.

### 5. Update the docs

Add a row to the agent table in `docs/agents.md` and to the `termyte install` examples. Update the supported-platforms list in the README.

## Adding a new synthesis adapter

A synthesis adapter wraps a specific agent's CLI/SDK and exposes a uniform `invoke(prompt, opts)` method. The Batcher is agent-agnostic; all agent-specific logic lives here.

### 1. Implement the interface

```ts
// src/synth/my-agent.ts
import { spawn } from "node:child_process";
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from "./types.js";
import { AgentInvocationError } from "./types.js";
import { resolveBinaryPath } from "./resolve.js";

export class MyAgentAdapter implements AgentAdapter {
  readonly id = "my-agent" as const;
  readonly displayName = "My Agent";

  async isAvailable(): Promise<boolean> {
    const path = await resolveBinaryPath("my-agent", ["MY_AGENT_PATH"]);
    return path !== null;
  }

  async invoke(prompt: string, opts?: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const bin = await resolveBinaryPath("my-agent", ["MY_AGENT_PATH"]);
    if (!bin) {
      throw new AgentInvocationError("not_available", "my-agent CLI not found in PATH");
    }
    return runMyAgent(bin, prompt, opts ?? {});
  }
}

async function runMyAgent(bin: string, prompt: string, opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
  const args = ["run", "--no-session", "--output-format", "json"];
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) {
    args.push("--max-budget", opts.maxBudgetUsd.toFixed(4));
  }

  return new Promise<AgentInvokeResult>((resolve, reject) => {
    const startedAt = Date.now();
    const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new AgentInvocationError("timeout", `my-agent timed out after ${opts.timeoutMs}ms`, stderr));
        }, opts.timeoutMs)
      : null;

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        reject(new AgentInvocationError("non_zero_exit", `my-agent exited ${code}`, stderr));
        return;
      }
      // ... parse stdout, extract text + usage ...
      resolve({ text, json, usage, durationMs: Date.now() - startedAt });
    });

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        proc.kill("SIGKILL");
        reject(new AgentInvocationError("cancelled", "aborted", stderr));
      });
    }
  });
}
```

Key conventions:

- Never throw for user-recoverable errors — wrap them as `AgentInvocationError` with a `reason` from the allowed set: `not_available`, `timeout`, `cancelled`, `rate_limited`, `non_zero_exit`, `invalid_output`, `internal`.
- Honor `opts.timeoutMs`. Kill the subprocess and reject with `reason: "timeout"` if it elapses.
- Honor `opts.signal` (AbortSignal). Kill the subprocess and reject with `reason: "cancelled"` if it fires.
- Honor `opts.maxBudgetUsd` **only if the underlying CLI supports it**. Pass it through; don't try to enforce it in user space.
- Report `usage.input` and `usage.output` token counts when the CLI gives them. The Batcher aggregates them across the run.
- Use `--no-session-persistence` (or the agent's equivalent) so the synthesis call doesn't pollute the user's interactive session history.
- Run as a one-shot subprocess or via the agent's SDK. Do not block the user's active session.

### 2. Register the adapter

Add the id to `AgentAdapterId` in `src/synth/types.ts`:

```ts
export type AgentAdapterId = "claude-code" | "codex" | "opencode" | "gemini-cli" | "my-agent" | "fake";
```

Add a `case` to `createAdapter` in `src/synth/index.ts`. If the adapter is well-supported and shouldn't require `TERMYTE_SYNTH_ADAPTER` to be set, also add it to the priority list in `discoverAdapter()`.

### 3. Add tests

Add `test/synth-my-agent.test.ts`. Use `FakeAdapter` (which the Batcher can also use) for Batcher-level tests; the adapter-specific test should focus on subprocess handling, output parsing, and error wrapping.

### 4. Update the docs

Add the agent to the synthesis column in `docs/agents.md`, and add a section to `docs/getting-started.md` if the user needs to install a CLI before termyte can use it.

## Style and process

- **Match existing style.** Read neighboring files before editing. Use the same TypeScript conventions, error-handling patterns, and test patterns.
- **No new dependencies** unless they earn their place. `better-sqlite3`, `@xenova/transformers`, `sqlite-vec`, and `node:` built-ins are the standard toolkit.
- **Crash-safety.** Anything that processes a trace must update `processed_at` only after success.
- **Boundedness.** Anything that calls an LLM must respect the daily budget caps and the per-batch timeout.
- **Tests required for new behavior.** A bug fix should add a regression test.
- **Open a PR** with the agent + installer + tests + docs. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Internal helper: `resolveBinaryPath`

`src/synth/resolve.ts` exports `resolveBinaryPath(name: string, envVars: string[])` which checks `PATH` and a list of env-var overrides (e.g. `CLAUDE_PATH`, `CODEX_PATH`). Use this in every `isAvailable()` / `invoke()` to give users a way to point termyte at a binary that's not on `PATH`.
