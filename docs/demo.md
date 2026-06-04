# Termyte Alpha Demo

This demo is safe to run because dangerous-looking commands are passed only to
`termyte check` or `termyte policy test`. Those commands evaluate text and do
not execute it.

The demo creates local policy, log, and memory files. Run it in a temporary
directory.

## Setup

PowerShell:

```powershell
$demo = Join-Path $env:TEMP ("termyte-demo-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $demo | Out-Null
Set-Location $demo
```

POSIX shell:

```bash
demo="$(mktemp -d)"
cd "$demo"
```

## Run The Demo

Check dangerous command text without executing it:

```bash
termyte check "cat .env"
termyte check "git push --force origin main"
termyte check "npm publish"
termyte policy test "cat .env"
```

Expected:

- Secret access and force push checks are blocked.
- Package publishing warns.
- `policy test` evaluates without writing a check log.

Preview and save a deterministic local policy:

```bash
termyte policy local add "Ask before touching auth or payments" --dry-run
termyte policy local add "Ask before touching auth or payments" --yes
termyte policy show
```

Expected:

- The dry run prints YAML and writes nothing.
- The save command creates `termyte.policy.yaml`.
- Policy show includes `ask-auth-payment-changes`.

Inspect blocked logs:

```bash
termyte logs --blocked
```

Demonstrate memory influence with an otherwise allowed command:

```bash
termyte mark-unsafe "npm test"
termyte check "npm test"
termyte memory
```

Expected:

- `npm test` is marked unsafe but is not executed.
- The later check upgrades the decision from allow to warn.
- Memory lists `npm test` under unsafe patterns.

Run local diagnostics:

```bash
termyte doctor
```

Doctor includes environment-dependent checks. Optional missing tools can appear
as warnings. Doctor success does not mean Termyte is a sandbox or can observe
every execution path.

The agent runner uses `runtime mode: limited`. Full subprocess interception is
not guaranteed, and this demo does not launch a coding agent.

## Files Created

The demo may create:

```text
termyte.policy.yaml
.termyte/logs.jsonl
.termyte/memory.jsonl
```

Delete the temporary demo directory when finished.
