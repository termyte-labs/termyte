# Architecture

Termyte is a local-first policy runtime around agent actions. The core runtime
does not depend on a specific agent. Agent integrations adapt Codex, Claude
Code, MCP, or direct CLI input into the same command/action analysis path.

```text
Agent hook / CLI / MCP
        |
        v
Runtime action normalization
        |
        v
parser -> target resolver -> risk engine
        |
        v
policy mode + policy rules + approvals + memory
        |
        v
allow / warn / ask / block
        |
        v
ledger + memory observation
```

The shared code lives in `action-model.ts`, `parser.ts`, `resolver.ts`,
`risk.ts`, `evaluator.ts`, and `runtime.ts`.

## Runtime Boundaries

- `termyte run -- <command>` is the direct enforced command gate.
- `termyte mcp serve` exposes governed MCP tools for agents that can use MCP.
- `termyte agent hook <claude|codex>` maps native hook JSON into Termyte's
  runtime evaluator.
- `termyte run <agent>` launches the agent with Termyte environment variables,
  but it is not itself a sandbox.

Termyte fails closed for recognized destructive actions. It does not claim OS
sandboxing or complete command interception for commands that bypass Termyte.
