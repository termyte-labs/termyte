# Contributing

Thanks for helping improve Termyte.

## Before you start

For a large change, open an issue first so the scope is clear. Small fixes and documentation changes can go straight to a pull request.

## Local setup

Requirements:

- Node.js 20 or newer
- npm

```bash
npm install
npm run verify
```

`npm run verify` checks the TypeScript, builds the project, and runs the tests, including the installed-package test.

## Pull requests

- Keep each pull request focused.
- Add or update tests when behavior changes.
- Update the README or docs when user-facing behavior changes.
- Explain any migration, compatibility, or security impact.
- Do not include database files, logs, credentials, or generated `dist` changes unless the change specifically requires them.

Please describe what changed, why it changed, and how you checked it.
