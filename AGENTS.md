# unblock

A queue for requests that need a human decision.
Used by agents and the Rails workspace.

## Read first
1. This file.
2. `README.md`.
3. `docs/scope-blocks.md` for scope workflow.

## Check
`./check` runs the whole fast loop. `./check --staged` is the pre-commit hook.

## Land
Fast-forward push to `origin/main`.
The commit body carries a `check:` line: one bare shell command the gate runs.

## Worktrees
The main checkout `/Volumes/StudioExt/repos/unblock` stays on `main`.
Other branches: `git worktree add ../unblock-wt/<topic> -b <branch> origin/main`.

## Topics
Scope workflow: `docs/scope-blocks.md`.

## Repo facts
Node.js 22 or newer; run tests with `npm test`.

No unit tests (Alex, 2026-10-19). Prove behavior through the running app, HTTP, a CLI subprocess, MCP transport or a real install. Keep kept-floor guards (outbound approval, spend caps, destructive-data approval, secret redaction, Alex’s credentials) and never thin them. Delete unit tests you touch.
