# Policy Modes

Prompt-level modes are part of the intended product shape:

- `off`
- `observe`
- `standard`
- `strict`
- `paranoid`

Mode is read from global `~/.termyte/policy.yaml` and project
`./termyte.policy.yaml` files. Project mode overrides global mode. If no file
sets a mode, Termyte uses `standard`.

The intended mapping is:

- `off`: allow actions while still showing that policy enforcement is disabled.
- `observe`: allow actions while recording what Termyte would have enforced.
- `standard`: block obvious destructive actions and warn on risky actions.
- `strict`: require approval for medium-risk actions and block high-risk
  actions.
- `paranoid`: block secrets, publishing, deploys, force pushes, broad deletes,
  and sensitive config edits; warnings require approval.

Current implementation detail:

- `strict` upgrades medium-risk warnings to `ask` and high-risk non-blocks to
  `block`.
- `paranoid` upgrades warnings to `ask` and high-risk non-blocks to `block`.
- `observe` and `off` return `allow` but include the original decision in the
  reason so logs and inspection still show what would have happened.
