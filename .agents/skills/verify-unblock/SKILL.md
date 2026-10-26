---
name: verify-unblock
description: Verify Unblock's queue, scope documents, web panels and agent integrations without using personal sessions or live asks.
---

# Verify Unblock

## Launch

Run from the repository root with Node.js 22+ and Python 3. Use the installed factory tools in `~/.agent-rails/factory-runtime/bin/`.

Do not start the default daemon: it can discover personal configuration and notify real agent panes. Launch behavioral journeys only through `feature-map run` on the dedicated proof host, with a fresh service identity, isolated HOME/config/data, loopback daemon, notification capture sink and runner-owned cleanup. Studio is the merge host, not the journey host.

The current seed backends are deliberately unavailable. They create no account, daemon, panel or data. No running-app verification is claimed until those backends and runner isolation are implemented.

## Doctor

Run these read-only prerequisite checks from the root:

```sh
node --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
python3 --version
~/.agent-rails/factory-runtime/bin/feature-map check --repo .
```

Doctor validates runtime and map prerequisites only. To inspect identity readiness, run `test-identity SERVICE --repo . --json` using the same toolkit directory for `unblock`, `plan`, `hermes` and `herdr`. Exit 3 means unavailable, not failed behavioral assertions and not a pass. Stop at this gate; do not substitute personal sessions, Railway/wrangler credentials or a live daemon.

## Drive

The top three journeys per product are registered in the feature front matter:

| Product | Feature / proof | Required observation |
|---|---|---|
| human-asks | file / file-isolated-ask | Synthetic ticket and pending state persist |
| human-asks | list / list-own-pending-asks | Lane filtering excludes unrelated and closed asks |
| human-asks | answer / answer-and-close-ask | Answer consumed once; closure removes pending row |
| scope-docs | scope / publish-isolated-scope | Content, attachment and hashes survive reload |
| scope-docs | http-scopes / scope-thread-roundtrip | Anchored thread persists; stale edit rejected |
| scope-docs | mcp-approvals / scope-approval-roundtrip | Synthetic approval and revocation round trip |
| web-panel | index / queue-answer-in-browser | Browser answer persists after reload |
| web-panel | index / queue-lane-filter | Browser filter preserves unrelated asks |
| web-panel | scope / scope-pinned-thread-in-browser | Thread anchor and resolution survive reload |
| integrations | hermes-unblock-file / hermes-file-ask | Plugin response matches stored synthetic origin |
| integrations | hermes-unblock-check / hermes-consume-answer | Plugin consumes answer exactly once |
| integrations | herdr-open / herdr-open-test-panel | Disposable profile opens only seeded daemon |

For each feature in the table, run:

```sh
~/.agent-rails/factory-runtime/bin/feature-map run --repo . --feature human-asks/file --env sandbox --json
```

Replace the feature selector with the relevant product/feature; `web-panel/index` runs both its proofs. Optional `--proof ID` selects one. Run only against the checked-out commit; the runner keys records by that SHA. Repeat after landing to associate records with a SHA on main.

All current commands are explicit availability gates returning exit 3, not implemented journey drivers. The runner may block first because journey placement or side-effect enforcement is unavailable. Never change kind to a static check or strip declared side effects to make a journey green. Once backend support exists, implement the documented assertions against real CLI/HTTP/MCP/browser transport and leave containment to the runner.

## Evidence

```sh
~/.agent-rails/factory-runtime/bin/feature-map runs --repo . --latest --json
```

Inspect each record's SHA, result and evidence references. The central store is `~/.agent-rails/runs/unblock/`; workers spool until acknowledged. Evidence includes `detail.json`, stdout/stderr and cleanup results. Report blockers verbatim, never call a record-count check behavioral verification. A blocked result does not satisfy ready/verified status.

When browser drivers become available, capture light/dark desktop and phone PNGs in the runner evidence directory without opening Alex's browser. There are no screenshots for unavailable journeys.

## Cleanup

Each backend supports `scripts/test-identity/SERVICE --cleanup`, a no-op receipt because unavailable backends allocate nothing. Its identity response has `cleanup_cmd: null`; do not fabricate an identity lease. The feature runner owns temporary checkout and attempt cleanup even when a command blocks.

A future available backend must return an actual cleanup argv for its own fresh tenant, and the runner must invoke it after success, failure, timeout or blocked attempts. Stop only processes owned by that attempt. Never delete real asks, scopes, accounts or another lane's state. Never message people or use Alex's signed-in accounts. A production proof additionally requires `agent-test-account --lane weekend-finish`; this skill does not launch production checks.
