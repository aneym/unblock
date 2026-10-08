# unblock

One queue for everything your agents need from you.

An agent that hits a wall only a human can clear — an API key, a console click,
an OAuth grant, an approval — registers a structured ask and either keeps
working or parks. You answer a batch of them on one page, secrets included, and
the parked ones wake up.

You never read a transcript to find out what an agent wanted.

An ask closes by itself when its filer's process ends, its permission path is
gone, or a `closes_on` PR, issue or scope comment is done. Lanes get a keep-or-close
check at 30 minutes. Asks nobody keeps are set aside, not lost; find them with
`unblock list --aside` and bring one back with `unblock keep <ticket>`.

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

The installed Studio daemon polls live-doc approvals every 60 seconds, logs them in the scoping INDEX, and moves approved tabs to In flight (`UNBLOCK_LIVEDOC_APPROVALS=0` disables it; `UNBLOCK_LIVEDOC_POLL_MS` sets the interval).

Day-old open asks go back to the filing lane once via `lane-post`; three-day-old asks move to the weekly decide-or-drop list and stop counting toward today. A recheck that fails three times is given up (`recheck_unavailable_at`). Configure the thresholds with `UNBLOCK_RECHECK_AFTER_MS` and `UNBLOCK_WEEKLY_AFTER_MS`, and the delivery executable with `UNBLOCK_LANE_POST_BIN`.

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

## Real blockers only

The queue costs a human attention, so the daemon only takes what only they can do. Every ask
carries `only_you`, the reason: `credential` (their sign-in or key), `their_account` (a click in
a console signed in as them), `spend` (money or a new account), `message` (a message to a real
person) or `judgment` (a product call). It also carries `tried`: one to eight lines saying what
the agent ran or attempted and why that could not clear it. A manual step needs a deep link to
the exact screen, not a home page. Titles and labels are checked for repo jargon. A second open
ask with the same project and title is refused with the existing ticket.

Each ask carries a `level`: P1 means a real person or money is waiting, or something is down; P2 holds up a lane or a build; P3 is a scope round or something shipped to review; P4 means decide when it suits you. If omitted, message and spend asks default to P1; blocker, consent, permission, or asks with dependent work default to P2; the rest default to P4. The queue sorts by level, then project order (Recruiter, Closer, Rails, Poker), then dependent work and age. Set `UNBLOCK_PROJECT_ORDER` to override the order, for example `Poker=poker;Recruiter=recruiter,chord`.

## CLI

```
unblock [list] [--all] [--project P]   what is waiting, grouped by project
unblock show <ticket>                  one ask in full (never secret values)
unblock answer <ticket> <value>        answer a one-question ask in one line
unblock answer <ticket> name=value ... answer by question name
unblock close <ticket> <reason...>     withdraw an open ask with a one-line reason
unblock file [path|-]                  file an ask from JSON
unblock update <ticket> [path|-]       revise an open ask
unblock link <ticket> [--share]        the stable queue link, or a 15-minute share link
unblock daemon start|stop|restart|status
```

`--json` works on every command except `reveal`, `ui` and `mcp`. Exit codes: 0 ok, 1 daemon
unreachable, 2 usage, 3 no such ask, 4 rejected by the queue, 5 ask is not open.

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

### Claude Code in herdr panes

Add these hooks to `~/.claude/settings.json` (replace `/path/to/unblock` with your installed package path):

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node /path/to/unblock/hooks/claude-ask.js" }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node /path/to/unblock/hooks/claude-permission.js" }] }]
  }
}
```

In herdr panes, questions go to unblock; permission prompts stay visible until you answer. Set `UNBLOCK_ALLOW_DIALOG=1` to use Claude's dialogs instead. Outside herdr panes the hooks do nothing.

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
loopback are rejected. `rails_origins` (env `UNBLOCK_RAILS_ORIGINS`) lists extra https parent origins for the demo embed bridge; a comma-separated string works, invalid entries are dropped, and an already-set environment variable wins. Requests whose Host is neither loopback nor that origin
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

## Scoping pages

A scoping page is one document with comments anchored to quotes. Open comments
are questions or comments; resolved comments hold decisions. The page lives at
`<public_origin>/s/<slug>`, with state under `UNBLOCK_SCOPING_DIR`
(default: `~/.agent-rails/scoping`). Only the daemon writes `scope.json`.
Set `scope_link_template` (env `UNBLOCK_SCOPE_LINK_TEMPLATE`) to an https URL containing `{slug}`; CLI `url` is the canonical link and `studio_url` is the Studio page, with both using the Studio page when no template is set.

Lanes use the CLI instead of editing that file. A No keeps a question open; a
new option uses `scope reply <slug> T# --rec "option" [--why "reason"] "reply"`.
```bash
unblock scope ask demo --section plan --quote "phones first" --rec "Phones first" --option "Phones first" --option "Desktop first" "Which screen ships first?"
unblock scope react demo T4             # acknowledge; --clear removes it
unblock scope reply demo T4 "Moved voice to round two."
unblock scope doc demo --from plan.md
unblock scope patch demo plan --from section.md
unblock scope edit demo T4 --section plan --quote "We build for phones first" --option "Phones first" --option "Desktop first"
unblock scope resolve demo T4
unblock scope comments demo --open
```

`scope resolve` requires `--decision "why"` on Alex's comment. Alex resolves his own comments; a lane may close one with either:

- `--quote "his exact words"`: close words from his latest message in that comment.
- `--revision N`: for a change request, the later revision that changed the anchored section.

`unblock scope reopen demo T4 [--reason "text"]` reopens one. When Alex's own answer is a question, `scope comments` flags it; reopen it and answer instead of confirming.

`unblock scope app <slug> recruiter|closer|rails-admin` files a scope under its app in Development area.

Approve scope on the page with an optional final note; the lane receives APPROVED and the note, then moves to build (with changes: fold the note into the doc first).

Use a fence with opening line `` ```demo ``, then `src: demo.html` (or an https URL) and closing line `` ``` ``; optional keys are `height`, `frame` and `allow`, and local `src` files are uploaded.
Use `` ```video `` with `src: recording.mp4` and optional `poster: cover.png`, then `` ``` ``; local `src`/`poster` files are uploaded, and a following `Figure:` caption anchors comments.
Terms, examples, do/don't pairs, before/after, steps and stats have their own fences: [docs/scope-blocks.md](docs/scope-blocks.md).

A markdown doc starts with `# Title`; `## Heading {#stable-id}` starts a section.
JSON input is a sections array or `{sections}`. Doc rewrites keep all comments;
comments whose quotes disappeared are reported as detached. Each rewrite saves
a revision. `scope doc <slug>` exports markdown; `--json` gives revision and sections.
`scope edit <slug> T# [--section id --quote "text"] [--option "text" ...]` moves a comment to
its new sentence and/or sets its options without adding a message, changing its status or notifying the pane.
Only lanes can edit comments. Questions accept 2–5 options of 1–200 characters, with the
current recommendation first. Repeat `--option` on `ask`, `edit` or a `reply --rec`;
a new recommendation without options removes the old list. The API also accepts an
empty options array to remove it. `scope comments` lists options after the recommendation.
Existing v1 files are read as v2 and backed up on their first write.
A trusted tailnet viewer can select text to comment, reply or resolve a comment.
Their actions reach the lane's pane; Not now parks a comment. Tags such as
`@pHS` or `@another-scope` also route the comment to that lane. After a decision, the lane rewrites the doc
and confirms it with `scope resolve`. A reply without T# is a general comment.
`scope list`, `scope url <slug>` and `scope notes <slug> [--since N]` remain;
all scoping commands support `--json`. Voice uses the same comment paths and the
queue's voice keys, spend ledger and $20 monthly cap.

### Unslop gate

Lane-written headings, body text, captions and comment text are checked for AI tells
and internal jargon. Code, images and URLs are skipped; human and Admin relay
words are never checked. Findings refuse the write with HTTP 422 and CLI exit 2.
Run `/unslop`, then `unblock scope lint <slug> --from doc.md` to check locally
without publishing. Repeat `--keep "Name"` to keep a real name on lint or a write.
Sections over 120 prose words get a warning, not a refusal.
Doc writes and local lint check only new or changed sections; if lint cannot read
the current scope, it checks every section and says so.

### Scope images and mocks

Put each image on its own line: `![Inbox](mocks/inbox.png)` or
`![Phone inbox](mocks/inbox.html "phone")`. `unblock scope doc <slug> --from doc.md`
uploads local images and inlines and renders HTML mocks in light and dark themes.
Mocks get a viewport tag if they lack one, and `"phone"` renders at 390 CSS px (780 px image; desktop at 1280 CSS px). Adjacent image lines share a
following `Figure: <caption>` line. Questions anchor to that caption, not the image's
alt text. Exports keep the stored `asset:` references, so re-importing needs no render.

`POST /api/scope/<slug>/threads/<T>/pick {text}` is a human-only, read-only ask picker; `UNBLOCK_ASK_PICKER_BIN` selects its binary and `UNBLOCK_ASK_PICK_MIN` sets the confidence cut (default 0.6).

### Development area relay

The `unblock-admin-relay` agent-secret handle (override with
`admin_relay_key_ref` / `UNBLOCK_ADMIN_RELAY_KEY_REF`, or set
`UNBLOCK_ADMIN_RELAY_TOKEN`) enables a scope-only relay when the token has at
least 32 characters. Send it in `X-Unblock-Relay` on loopback hosts only.
The relay may read `GET /api/scope`, `GET /api/scope/<slug>` and
`GET /api/scope/<slug>/assets/<id>`, create human
comments with `POST /api/scope/<slug>/threads`, and use the four comment write
verbs `reply`, `resolve`, `reject`, `park`, `reopen`, and `delete`. Each write requires a unique
`client_id` (1–64 letters, digits, underscores or hyphens) so retries do not
land twice. Writes are marked `via: admin`; that field may be omitted or set
to `admin`, never another channel. No other daemon route accepts this credential.

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

Alex’s scoping comments can carry pictures; the lane gets a local path per image.

`reopen` lets Alex or the Admin relay reopen a resolved or parked comment without changing the doc revision.
`delete` lets Alex or the Admin relay delete a note Alex started and notifies the lane.

Visual review docs (`unblock scope new <slug> --pane <pane> --kind visual`) show full slide images with area comments and the existing comment sidebar. Import a numbered image directory or a JSON slide manifest with `unblock scope slides <slug> --from <dir|slides.json>`; drag over a slide to mark an area (on touch screens, tap “Mark an area” first). Region comments preserve their slide coordinates and, when available, a cropped image for the lane to inspect.
