# Approvals And Mark-Safe Memory

Termyte supports two local override primitives:

```bash
termyte allow-once "npm install zod"
termyte mark-safe "npm run build"
termyte approvals
```

`allow-once` stores a repo-scoped one-time approval in
`.termyte/approvals.json`. The matching command is allowed once when it is later
run through Termyte, then the approval is marked used. It expires after 30
minutes. Termyte refuses to store one-time approvals for blocked commands unless
`--force` is provided.

`mark-safe` stores a repo-scoped safe memory in `.termyte/memory.jsonl`. It can
reduce repeated warning noise for commands that already warn. It does not
override critical blocks.

SQLite memory in `.termyte/termyte.db` records runtime observations: allowed,
warned, blocked, failed, and repeated semantic patterns.

