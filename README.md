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

## Layout

```
src/schema.js    ask + field validation, the profile rule
src/store.js     SQLite queue, one-park-per-agent, drafts, links
src/secrets.js   1Password -> keychain -> env file
src/daemon.js    HTTP API, the answer page, SSE
src/mcp.js       MCP server: file / park / check / cancel
web/             the answer page
plugin/          herdr plugin
skills/unblock/  the discipline agents follow before parking
```

Zero npm dependencies. The queue is one SQLite file at
`~/.local/state/unblock/queue.db`.

## License

MIT
