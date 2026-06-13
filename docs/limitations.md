# Limitations

Termyte is a local policy runtime, not a complete sandbox.

Current limitations:

- No OS-level containment.
- No cloud policy management.
- No dashboard, billing, enterprise auth, or multi-tenant control plane.
- No guarantee that every command run by every agent is intercepted.
- `termyte run <agent>` is an interactive direct launcher; enforcement depends
  on hooks, MCP, or commands routed through `termyte run -- <command>`.
- Parser coverage is semantic and pattern-based, so obfuscated shell commands
  may not be recognized.
- Policy modes are documented as product direction but not fully implemented as
  a runtime mode switch.
- Local memory can reduce warnings but must not override critical blocks.

Use `termyte prove-runtime`, `termyte hooks doctor`, `termyte hooks smoke
<agent>`, and `termyte doctor` to verify the current machine state.
