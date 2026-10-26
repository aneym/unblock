---
id: agent-hooks
product: integrations
owner: unblock-lead
status: live
covers: []
paths: ["hooks/**", "skills/**"]
proofs: []
unmapped:
  - {"path": "scripts/**", "date": "2026-10-18", "reason": "Build/vendor and e2e scripts require separate isolation and outbound-containment classification before proof registration."}
---
# Agent hooks and skills

## Sub-features

Claude permission hook (bypass auto-allow, nested-delete deny, and a deny in agent panes so no permission prompt becomes an ask), the question hook and its pane wake callback, shared hook helpers and agent skills.

## How to get to it

Configure the repository hooks and skills in the agent runtime.

## Driving it

Read the hook input contract before wiring an isolated agent to a test daemon.

## Gotchas

Permission hooks are not authority grants. Deployment and existing e2e scripts remain inventoried but are not certified as isolated proofs.
