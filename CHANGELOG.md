# Changelog

## 0.3.0 Alpha

### What Works

- Non-executing command checks for known risky command patterns.
- Built-in defaults plus global and local YAML policy files.
- Deterministic natural-language policy creation with visible YAML previews.
- Repo-local JSONL logs and memory.
- Local doctor diagnostics.
- Limited agent runner support for `codex`, `claude`, `claudecode`, and
  `aider`.
- `claudecode` falls back to `claude` when appropriate.

### Experimental

- Shell and runtime interception.
- Shim and shell-hook coverage.
- Cross-platform subprocess governance.

### Known Limitations

- Runtime mode is limited.
- Full subprocess interception is not guaranteed.
- Termyte is not a sandbox.
- Termyte reduces accidental damage but does not make agents safe.
- Commands and API calls that bypass Termyte are not governed.
- Natural-language policy creation supports deterministic templates only.
- Stable check logs and memory are repo-local JSONL files.

### Install

```bash
npm install -g termyte
```

### Quickstart

```bash
termyte check "cat .env"
termyte policy local add "Ask before touching auth or payments" --dry-run
termyte policy local add "Ask before touching auth or payments" --yes
termyte logs
termyte memory
termyte doctor
```

Use the `alpha` npm distribution tag for alpha releases. Do not publish this
version as `latest` without a separate release decision.
