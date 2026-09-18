# unblock

One queue for everything your agents need from you.

An agent that hits a wall only a human can clear — an API key, a console click,
an OAuth grant, an approval — registers a structured ask and either keeps
working or parks. You answer a batch of them on one page, secrets included, and
the parked ones wake up.

You never read a transcript to find out what an agent wanted.

## Why it exists

Every human-in-the-loop tool for agents solves one third of this problem.
LangGraph's `interrupt()` has the right waiting semantics and ships no queue or
UI. HumanLayer and gotoHuman have structured requests and route them through a
SaaS. The local MCP question servers are single-agent, synchronous, and hand the
answer straight back through the tool result — which is exactly where an API key
must never go.

unblock is the three together: local-first, secrets that stay out of the model's
context, and one queue across every agent on the machine.

## Product boundary

Unblock is a standalone local service. It owns one daemon, HTTP API, SQLite
database, and answer UI. Agent integrations are clients of that service:

- Hermes registers native `unblock_file`, `unblock_park`, `unblock_check`, and
  `unblock_cancel` tools plus the Unblock skill.
- The Herdr plugin is only a launcher and pane adapter for the same UI. Herdr is
  not a queue owner or synchronization peer.
- Every client reaches the same database at
  `~/.local/state/unblock/queue.db` unless `UNBLOCK_STATE_DIR` is set.

## How it works

Two calls, and only one of them stops the agent.

| call | blocks? | how many at once |
| --- | --- | --- |
| `unblock_file` | no — returns a ticket, agent keeps working | unlimited |
| `unblock_park` | yes — holds until answered | **one per agent** |

That single constraint is what makes partial answering safe. Answering a filed
ask never interrupts anything, so you can answer them in any order. Answering
the parked one wakes the agent, and it collects every filed answer that landed
while it was away.

An agent that needs three things declares one park with three fields. It does
not park three times, because it can only be stopped in one place.

| tool | does |
| --- | --- |
| `unblock_file` | register an ask and keep working |
| `unblock_park` | register an ask and wait on it |
| `unblock_peek` | read what they have typed so far, without consuming it |
| `unblock_update` | revise an open ask in place — add, drop or reword questions |
| `unblock_check` | collect answers, and see what is part way filled in |
| `unblock_cancel` | withdraw an open ask |

## Live asks

An ask is not a form you post and walk away from. Every keystroke drafts to the
daemon, so an agent can watch someone think and ask the obvious follow-up while
they are still on the page.

The loop is: **file → watch the drafts → `unblock_update` → check.**

```
unblock_file   ub_7xk2m9   "which database?" + "which region?"
               human picks "the replica"
unblock_peek   ub_7xk2m9   draft.database = "replica"
unblock_update ub_7xk2m9   add_fields: [{ name: "lag_tolerance", ... }]
               the open page grows a third question on its own
unblock_check  ub_7xk2m9   all three answers at once
```

`unblock_update` mutates an OPEN ask through the same schema as `unblock_file`,
so a revision can never reach a shape a fresh ask could not. It keeps the
ticket, the link they already have open, and every draft on a field it does not
touch. Removing a field takes that field's draft and note with it. An answered,
bounced or cancelled ask is refused: a revision would change the question they
already answered.

Three ways to watch, cheapest first:

```bash
# one shot — draft_updated_at only moves when a human types
curl -s -H "Authorization: Bearer $(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.local/state/unblock/daemon.json")))["auth"])')" \
  http://127.0.0.1:4488/api/asks/<ticket> | jq .draft_updated_at

unblock peek <ticket>        # the same thing, readable

# a push stream: draft, updated, answered, sent_back, cancelled
curl -sN -H "Authorization: Bearer $UNBLOCK_AUTH" \
  http://127.0.0.1:4488/api/asks/<ticket>/events
```

`GET /api/asks/:ticket` returns the ask with `draft`, `draft_reply`,
`field_context`, `draft_updated_at`, `updated_at` and `status`. Like everything
under `/api` it is loopback-and-tailnet only, and it carries the daemon secret
from `~/.local/state/unblock/daemon.json`.

A draft is not an answer. They are mid-thought, they can still change it, and
they have not pressed the button — read it to decide what to ASK next, never to
act on as though it were decided.

## Secrets

A secret typed into the form never travels back through the channel that lands
in a model's context. The daemon stores it and hands the agent a reference:

```
op://Private/abc123/credential        # 1Password — masks the value if printed
ub_9cjp4t-stripe_key                  # macOS keychain
$UNBLOCK_STRIPE_KEY                   # env file, 0600
```

The agent resolves it at the point of need and never prints it. 1Password is
preferred when `op` is signed in, because `op run` masks the value even if a
subprocess echoes it — the only backend with that protection.

## Install

```bash
npm install -g unblockd         # daemon, MCP server, CLI (binary: unblock)
unblock daemon start
```

Then point an agent at it. For Claude Code:

```bash
claude mcp add unblock -- npx unblockd mcp
```

And install the skill so agents know when to park:

```bash
npx skills add aneym/unblock --skill unblock -g
```

### herdr

```bash
herdr plugin install aneym/unblock --yes
```

### Hermes

From a canonical checkout, install the live source into one Hermes profile:

```bash
HERMES_HOME=~/.hermes/profiles/bot bin/hermes-install.sh
```

The installer symlinks both the native plugin and skill to this checkout, so a
pull in the canonical Unblock repo updates Hermes without creating a second
source tree. It then enables the plugin and runs Hermes' real plugin doctor.
Restart the active Hermes CLI/TUI/gateway process, or start a fresh session, to
load newly registered tools.

For a normal cloned plugin install instead of a live checkout, use
`hermes plugins install aneym/unblock --enable`; synchronize it explicitly with
`hermes plugins update unblock`.

### herdr:// deeplinks (macOS)

Each ask card links its origin pane (`pane w4D:p8`) as a `herdr://` URL, so a
click in the browser jumps straight to the pane that asked. Install the scheme
handler once:

```bash
bin/herdr-deeplink-install.sh
```

That builds `~/Applications/Herdr Link.app` (registered for `herdr://`) and
installs `~/.local/bin/herdr-deeplink`, which runs `herdr agent focus` on the
pane — falling back to the tab, then the workspace, when the pane is gone —
and brings the Herdr terminal forward.

`alt+p u` opens unblock mode: a zoomed pane with the whole queue, scoped to the
active profile, answerable in place. Answers wake the agent in its pane.

The plugin also lists agents herdr has detected as blocked but which never
declared an ask — below the declared ones, so a silent stall is still visible.

### Answering from a phone

`unblock link` mints an ephemeral URL. It dies when you submit and expires on a
timer, so a stale tab in your pocket is not still live tomorrow. Serve it over
your own tailnet, or use a quick tunnel if you have no tailnet:

```bash
tailscale serve --https=8799 127.0.0.1:4488     # tailnet only
cloudflared tunnel --url http://127.0.0.1:4488  # no account
```

### One stable tailnet URL

Behind `tailscale serve` the daemon can trust Tailscale's identity headers and
serve the queue at one bookmarkable address, no token in the URL. Put the
settings in `~/.config/unblock/config.json` so every spawner (the herdr startup
hook, an MCP server's auto-start, the CLI, launchd) starts the same daemon:

```json
{
  "public_origin": "https://studio.tailf266ac.ts.net:8797",
  "trusted_proxy": "tailscale",
  "allowed_users": ["you@example.com"],
  "root": "/path/to/this/checkout"
}
```

`public_origin` is exactly one https URL; wildcards, paths, and plaintext off
loopback are rejected. Requests whose Host is neither loopback nor that origin
get 403 before authentication runs. `trusted_proxy` only ever means Tailscale,
and only for requests that arrived on the public origin carrying a
`tailscale-user-login` in `allowed_users`. `root` names the checkout the daemon
must run from, so a second copy of this repo (a herdr-managed clone, say)
never wins the port with a stale panel. Environment variables of the same
names (`UNBLOCK_PUBLIC_ORIGIN`, `UNBLOCK_TRUSTED_PROXY`, `UNBLOCK_ALLOWED_USERS`,
`UNBLOCK_PORT`, `UNBLOCK_ROOT`) override the file. `GET /api/health` reports
`public_origin`, `trusted_proxy`, and which keys the file supplied.

Agents then hand out `https://<origin>/#ask=<ticket>`; for someone off the
tailnet, `POST /api/links {ticket}` still mints a burn-on-answer token.

## Layout

```
src/schema.js    ask + field validation, the profile rule
src/store.js     SQLite queue, one-park-per-agent, drafts, links
src/secrets.js   1Password -> keychain -> env file
src/daemon.js    HTTP API, the answer page, SSE (queue-wide and per ask)
src/mcp.js       MCP server: file / park / peek / update / check / cancel
web/             the answer page
plugin/          thin herdr launcher / pane adapter
hermes.py        native Hermes client for the standalone API
plugin.yaml      Hermes plugin manifest
skills/unblock/  the discipline agents follow before parking
```

Zero npm dependencies. The queue is one SQLite file at
`~/.local/state/unblock/queue.db`.

## License

MIT
