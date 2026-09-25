---
name: unblock
description: Ask the human for something only they can give: their sign-in or key, a click in their own account, spend, a message to a real person, or a product call. Use only after you have tried the CLI, the API, computer use and the docs yourself.
---

# unblock

The queue is for real blockers. Everything on it costs the human attention, so
everything on it must be something only they can do. The daemon enforces this:
an ask without proof that you tried is rejected.

## First, try to clear it yourself

Before you file anything, work the problem:

1. **CLI and API.** Is there a command, an API call or a token already on this
   machine that does it? Railway, GitHub, Cloudflare, Google Cloud and most
   consoles have one.
2. **Computer use.** Can you do it in a browser or app you are allowed to
   drive? Never drive the human's own signed-in accounts, sessions or browser
   without their explicit yes. That is a real blocker, so file it.
3. **Docs and code.** Is the answer in the config, the repo, the docs or an
   earlier answer? `unblock list --all` shows recent asks. Do not re-ask what
   is already decided.
4. **Standing permission.** Merges, deploys, infra fixes and keys the human
   already set up need no ask. Do them and report.

Only if all of that fails, and the reason is one of these, file an ask:

| `only_you` | means |
| --- | --- |
| `credential` | their sign-in, password, key or 2FA code |
| `their_account` | a click in a console or app signed in as them |
| `spend` | money, a paid plan or a new account |
| `message` | a message sent to a real person, as them |
| `judgment` | a product or taste call only they should make |

## What the gate checks

Every ask needs:

- `only_you`: one reason from the table. A decision allows `judgment`, `spend`
  or `message`. A blocker allows anything but `judgment`.
- `tried`: 1 to 8 lines, 20 to 400 characters each. Say what you ran or
  attempted and why it could not clear this: "railway variables set failed:
  project token lacks the backups scope", "opened console.cloud.google.com in
  the agent browser: it needs Alex's Google sign-in".
- A deep link to the exact screen when the human has to click something
  (`credential`, `their_account`). A home page or dashboard does not count. Use
  the console URL of the exact page, an app scheme (`codex://settings/...`) or
  a macOS settings pane (`x-apple.systempreferences:...`). Put it in `links`
  and name it in the step.
- Plain words in the title, labels and choices. The gate rejects `v1`, `ADR 12`,
  "rung", lane ids, ticket ids and file paths there. Write for someone who has
  never opened the repo: "the first version we ship", not "v1".
- One ask per blocker. Filing a second open ask with the same project and title
  is refused with the existing ticket. Revise that one instead.

## Blocker or decision

**Do I already know what should happen?**

- **Yes, but I cannot do it:** `purpose: "blocker"`. What is missing is their
  action. No recommendation, because there is nothing to guess.
- **No, and I should not guess:** `purpose: "decision"`. You did the work and
  formed a view. Every field carries `recommend: {value, why}`; their job is to
  ratify, not to author. A decision cannot ask for a `secret` or `paste`.

A blocker made only of choices is a question in disguise and is rejected.

## Filing

| call | blocks? | how many open |
| --- | --- | --- |
| `unblock_file` | no. Returns a ticket; keep working | unlimited |
| `unblock_park` | yes. Holds until answered | one per agent |

If you need three things before you can move, that is one park with three
fields. Call `unblock_check` when you resume. From a shell, `unblock file` takes
the same JSON on stdin.

Writing it:

- `title`: verb first for a blocker ("Add the callback URL to the Google
  client"), noun phrase for a decision. Under 90 characters.
- `why`: one or two sentences. What is stuck, and what starts working when this
  lands. No history, no "as discussed".
- `project`: one short workstream name, the same on every ask from it.
- `steps`: the shortest path, each step naming the exact screen and link.
- `fields`: one per thing you need back. `secret` for keys (never `text`),
  `confirm` for "I did it", `choice` for real options, `text` for names and
  URLs, `paste` for output only their machine can produce.

When you tell the human about an ask, send the title and its one link, nothing
else. Do not repeat the questions in chat.

## While they answer

Every keystroke drafts to the daemon. `unblock_peek {ticket}` (or `unblock peek
<ticket>`) shows what they have typed without consuming it. A draft is not an
answer: use it to decide what to ask next, never to act on.

`unblock_update {ticket, ...}` revises an open ask in place and keeps the
ticket, the open page and drafts on untouched fields. It takes `title`, `why`,
`steps`, `links`, `tried`, `only_you`, `add_fields`, `remove_fields` and
`replace_fields`. `replace_fields` swaps the whole list; to reword one question,
send it in `add_fields` under the same name. An ask filed before the gate
existed must include `tried` and `only_you` in its first update.

## Reading what comes back

| you get | it means |
| --- | --- |
| a value | answered; act on it |
| `(skipped: they chose not to answer)` | a real response. Proceed; do not re-ask |
| `SENT BACK, not answered` | the question was wrong. Rework it |
| a value plus `SENT BACK for rework` | a draft answer. Use it, and re-ask with their note addressed before you commit |

## Secrets

You never receive a secret value, only a reference with a `resolve` command.
Resolve it at the point of use and never print it: no `echo`, no `env`, no
`cat` of a secrets file. `unblock reveal` is for a human at a terminal.

## Good

```json
{ "purpose": "blocker", "kind": "file", "project": "billing",
  "only_you": "their_account",
  "tried": ["gcloud has no command to add a redirect URL to an OAuth web client",
            "the agent browser has no Google sign-in for this project, and Alex's own session is off limits"],
  "title": "Add the sign-in callback to the Google OAuth client",
  "why": "Sign-in fails at the redirect. Everything behind sign-in waits on this.",
  "steps": ["Open the client page (link below) and pick the web client",
            "Authorized redirect URIs → Add URI → https://app.example.com/auth/callback",
            "Save. It takes about five minutes to apply."],
  "links": [{"label": "Google OAuth clients", "url": "https://console.cloud.google.com/auth/clients"}],
  "fields": [{"name": "registered", "type": "confirm", "label": "Callback added"}] }
```

## Bad

- A question you could answer by reading the code, the docs or running a
  command. Answer it yourself.
- Asking approval for a merge, a deploy or an infra fix. Do it and report.
- `tried: ["n/a"]`, or a link to a dashboard home page.
- Three asks for one blocker, or three parks in a row.
- A `secret` asked as `text`: it lands in your context in plain view.
- Filing an ask and then stopping anyway. If you file it, keep working.
