# Handoff: Unblock agent wakeback

Branch `fix/agent-wakeback`, worktree `/Users/aneyman/.herdr/worktrees/unblock/fix-agent-wakeback`.
Commits: `bf080bc` (the fix), `d980fe0` (handoff hash), and a third commit adding the upgrade backfill; `git log --oneline -3` on the branch lists them.

## Incident

Hermes TUI session `20260904_092657_d38127` (profile `bot`) called `unblock_file` at 09:52:38.
The daemon created `ub_58vs3r`. Alex answered it in the UI at 10:01:46. The session was never told.
A manual `unblock_check` at 10:03:04 marked the ask collected and then failed the same way.

Evidence, from the live queue and `~/.hermes/profiles/bot/logs/agent.log`:

- `asks` row `ub_58vs3r`: kind `file`, origin `{"agent":"hermes","session_id":"20260904_092657_d38127"}`, answered 10:01:46, collected 10:03:04.
- agent.log 21792: `Tool unblock_file handler returned unsupported result type: dict` in session d38127.
- agent.log 17934: the same for `unblock_check` in session c3605c.

## Root causes

Two, and each alone would have lost the answer.

1. **Handler return contract.** Hermes' registry accepts only a `str` from a plugin tool handler
   (`~/.hermes/hermes-agent/tools/registry.py`, `_normalize_handler_result`, lines 1134 to 1165; the
   one structured exception is a multimodal envelope). Every Unblock handler returned a dict, so
   every call was replaced by a `tool_result_contract` error. `unblock_file` still created the ask
   at the daemon before the result was thrown away, so the agent filed a ticket it never heard about.
   `unblock_check` collected the ask (status `collected`) before its result was thrown away, so the
   answer was consumed and lost.

2. **No wake for filed asks.** Only `unblock_park` waited for an answer (a 3 s poll inside the tool
   call). A filed ask depended on the agent deciding, on its own, to call `unblock_check`. Nothing
   in the daemon, the UI, or the plugin told the originating session that an answer existed. The
   UI's "Answer & wake" label applied to parked asks only.

## Contract

- **Park** is unchanged: the tool call blocks, polls, renders the answer, collects, returns. Parked
  asks never get a wake, because the park call is already the waiter and a second delivery would be
  a duplicate.
- **File** now owes a wake. When a filed ask completes (answered or bounced), the daemon writes one
  durable `wakes` row keyed by the ask's `agent_key` (the originating `session_id`). A host claims
  wakes only for sessions it can reach, delivers the answer into that exact session as a message,
  and acks. A delivered ack collects the ask. A failed ack releases the lease with the error kept;
  the next claim retries. Leases expire on their own (default 60 s, plugin asks 90 s), so a host
  that dies mid-delivery is retried, not skipped. Wakes expire after 24 h (or the ask TTL if
  longer); the answer stays on the ask, collectable by ticket.
- **Dedupe.** One `wakes` row per ask (primary key `ask_id`). `collect` and `cancel` void a pending
  wake, so an `unblock_check` that beats the wake settles it. A delivered wake is terminal; a
  second ack is a no-op. Two claimers cannot both hold a live lease.
- **Isolation.** The unscoped list (`GET /api/wakes`) returns only ticket, title, status and a
  minimal origin, never answers. Answers leave the daemon only on a claim, and a claim is scoped
  to one exact `session_id` (or `pane_id`). Session ids are globally unique, so profile membership
  cannot cross. The Hermes watcher claims only after finding the session live in its own process.

## Design

### Daemon (Node)

`src/store.js`

- Table `wakes(ask_id PK → asks.id ON DELETE CASCADE, agent_key, status pending|delivered|void|expired, created_at, expires_at, claimed_at, lease_until, claim_token, attempts, delivered_at, last_error)`. Created with `CREATE TABLE IF NOT EXISTS`, so an existing `queue.db` migrates on open, and the migration backfills a pending wake (fresh 24 h expiry) for every filed ask already sitting `answered` or `bounced`, which is the incident class; the insert is `ON CONFLICT DO NOTHING`, so every open may run it. The lease expiry is stored on the row (`lease_until`, the holder's lease), and the claim `UPDATE` is conditional on it, so a later claimant with a shorter lease cannot take a live lease and two stores on one file cannot both win.
- `#promiseWake(ask, at)` from `answer()` (on completion) and `bounce()`; file kind only.
- `listWakes({agentKey?})`, `claimWakes(origin, {leaseMs})` (returns wakes with the collected ask and `outstanding`, the count of still-open filed asks for that session), `ackWake(ticket, {claimToken, delivered, error})`.
- `collect()` and `cancel()` void a pending wake. `sweep()` expires wakes past `expires_at`.

`src/daemon.js`

- `GET /api/wakes[?agent=&session_id=]`, `POST /api/wakes/claim {origin, lease_seconds}`, `POST /api/wakes/:ticket/ack {claim_token, delivered, error}`. All under the existing bearer auth.
- `settle(result)` replaces `emitQueue()` on the three answer routes; on a complete filed answer it also emits SSE `event: wake` with `{ticket, agent_key, origin}` and no answer content.

`src/schema.js`

- `origin.session_key` (optional). Hermes keys a live TUI session by `session_key` and records it in state.db by `session_id`; both travel so a wake can find the session by either name. `agent_key` still uses `session_id` only.

### Hermes plugin (Python)

`hermes.py`

- Every handler returns `json.dumps(payload)`; the structure is unchanged, only the type.
- `_origin()` adds `session_key` from `HERMES_SESSION_KEY` when it differs from the session id.
- `unblock_check` and `unblock_park` render the answer text before calling `collect`, so a lost result can no longer strand a collected answer.
- `unblock_file`, `unblock_check`, `unblock_park` arm the wake watcher for the current session. The `unblock_file` message now says the answer will arrive in the session.
- Daemon-down errors raise `wake.DaemonUnavailable` (a `RuntimeError`) so the watcher can back off.

`wake.py` (new)

- `WakeWatcher`: one daemon thread per Hermes process. Every 5 s it claims for each armed session, delivers, acks. Every 15 s it runs the recovery scan: `GET /api/wakes`, and for every owed Hermes session it can reach in this process, arms it. That is the restart path: a Hermes restarted after the human answered still delivers once the session is resumed. Daemon down: 60 s backoff. A session is disarmed when it has nothing open and nothing owed, or after 24 h.
- `HermesDelivery`: finds the live session and hands it the text.
  - tui_gateway (TUI, desktop, dashboard): `sys.modules["tui_gateway.server"]._sessions` (snapshot taken under `_sessions_lock`) matched on `session["session_key"] == origin.session_key` or `session["agent"].session_id == origin.session_id`. A session with `running` true (read under its `history_lock`) is not reachable: the watcher does not claim for it and waits for idle, because a mid-turn `prompt.submit` either interrupts the live turn (default `busy_input_mode`) or lands in a memory-only queue that a crash drops. When idle: `server.dispatch({"jsonrpc":"2.0","id":...,"method":"prompt.submit","params":{"session_id": sid, "text": text, "queued": true}}, session["transport"])`. `queued` pins the busy policy to queue-only so a wake that loses the idle race can never interrupt. `result.status == "streaming"` (an accepted turn) is acked as delivered. `queued` means a turn started in the race window and the text sits in the gateway's memory-only queue: the watcher withdraws that copy from `queued_prompt`/`queued_prompts` under the session's `history_lock` (mirroring `_enqueue_prompt`, including the text merge), leaves the wake owed, and the next idle pass sends it once; if no copy is found the queue already drained and the text is running, which counts as delivered. `steered`/`redirected` cannot occur with `queued: true` but would mean the live turn took the text, so they count as delivered rather than risk a duplicate. An error, no response, or an unknown status leaves the wake owed. Only used when the module is already loaded, never imported.
  - `hermes chat` CLI: `ctx.inject_message(text)` when the plugin manager's `_cli_ref.agent.session_id` matches.
  - Messaging gateway: `ctx.inject_message(text, session_key=origin.session_key)`, only when Hermes reports the `plugins.entries.unblock.allow_gateway_injection` grant and a live injector.
  - Anything else raises `SessionUnreachable`; the watcher acks `delivered: false` with the reason and the daemon retries later.
- Message shape: `[unblock] <ticket> was answered in Unblock. The answer is below and is already collected; do not call unblock_check for it. Act on it now.` followed by the same rendered answer text `unblock_check` produces.
- `UNBLOCK_HERMES_WAKE=0` disables the thread (tests drive `tick()` directly).

`__init__.py`

- `wake.set_context(ctx)` and starts the watcher at `register()` time, so recovery works without a tool call.

### UI

`web/src/SoloCard.tsx`: the post-submit status says "waking hermes" for a filed Hermes ask as well as for a parked one. Source only; `web/dist` is not rebuilt in this branch (builds are gated).

## Files changed

- `src/store.js`, `src/daemon.js`, `src/schema.js`
- `hermes.py`, `wake.py` (new), `__init__.py`, `package.json` (ships `wake.py`)
- `web/src/SoloCard.tsx`
- `test/wake.test.js` (new), `test/test_hermes_plugin.py` (rewritten)
- `README.md`, `.gitignore` (`__pycache__/`), `HANDOFF.md`

## Tests

`node --test test/*.test.js`: 68 pass, 0 fail (59 before, 9 new in `test/wake.test.js`, including the upgrade backfill on a `queue.db` with no `wakes` table).

`test/wake.test.js` covers: a filed answer creates one wake keyed to the exact session and the list never carries answers; another session lists and claims nothing; claim is a lease (second claimer gets nothing, wrong token is 409, failed ack releases with `last_error`, retry increments `attempts`, delivered ack collects the ask, re-ack is a no-op); bounce owes a wake; `collect` first voids the wake; park never gets a wake while `/api/pending` still serves it; cancel withdraws the wake; `outstanding` is per session; claim without identity is 400; SSE `wake` event names the ticket and agent key and carries no answer.

`python3 test/test_hermes_plugin.py`: 16 pass. Covers: every handler returns a `str` (JSON); `unblock_file` sends `session_id`, `session_key`, `profiles` and arms the watcher; `unblock_check` renders before collecting; the watcher claims, delivers and acks for the armed and reachable session only, never claims for an armed-but-unreachable one, never touches another session's wake, then disarms; a failed delivery releases the lease and is retried on the next tick; the recovery scan arms only reachable sessions and never claims for others; daemon outage backs off; tui delivery targets the matching `_sessions` entry by `session_key` and by `agent.session_id` under a recorded `_sessions_lock`, sends `prompt.submit` with the runtime sid, `queued: true`, on that session's transport; a running session is unreachable and is never dispatched to until idle; `status: streaming` counts as delivered; a `queued` response has its memory-only copy withdrawn (exact match, merged with user text, and overflow promotion) and keeps the wake owed, while a `queued` with no copy left counts as delivered; steered/redirected count as delivered; missing status, empty result, or no response keep the wake owed; the daemon lease cannot be stolen by a shorter-lease claimant (`test/wake.test.js`); no host means unreachable and never claimed; CLI delivery uses `inject_message`; gateway delivery needs the config grant. The last test runs the real `hermes plugins doctor` against the worktree: 4 tools registered.

Not tested end to end: a real tui_gateway process receiving `prompt.submit` from the watcher thread. The RPC shape was checked against `tui_gateway/server.py` (`_normalize_request` 3174, `_sess_nowait` 3676, `_handle_busy_submit` 10570, `_set_session_context` 4794) and `tui_gateway/methods_prompt.py` (`prompt.submit` 287).

## Rollout

1. Merge `fix/agent-wakeback` into `main` in `/Volumes/StudioExt/repos/personal/unblock`. The live Hermes plugin is a symlink to that checkout (`~/.hermes/profiles/bot/plugins/unblock`), so the merge is the plugin deploy.
2. Restart the Unblock daemon (`bin/unblock-restart.sh` or the launchd job). The `wakes` table is created on open and filed asks already `answered` or `bounced` are backfilled with a pending wake, so they are delivered once their Hermes host restarts with the new plugin.
3. Restart Hermes surfaces that should wake (the TUI/desktop gateway and any `hermes chat`) so they load the new plugin code. Until then the old handlers keep returning dicts and keep failing.
4. Optional, for messaging-gateway sessions (Slack, Telegram, photon): set `plugins.entries.unblock.allow_gateway_injection: true` in the profile's `config.yaml`. Without it those sessions stay collectable by `unblock_check` but are not woken.
5. Optional: `npm run web:build` to ship the status-copy tweak in the panel.

Verify after rollout: file an ask from a TUI session, answer it in the UI, and confirm an `[unblock] ub_… was answered` message starts a turn in that session within about 5 s; `sqlite3 ~/.local/state/unblock/queue.db "select * from wakes"` shows the row `delivered`.

## Remaining risk

- At-least-once, not exactly-once, across a crash between deliver and ack: if the host dies in that window the lease expires and the same answer is delivered again. The message names the ticket, so a repeat is recognisable.
- The opposite window is also open, and narrower: `prompt.submit` returns `streaming` once the turn is accepted in memory (`methods_prompt.py` ~930 and ~1061), and the durable crash marker is written by the turn's worker thread a few milliseconds later (`server.py` ~13254 to 13306). A tui_gateway crash inside that gap, after the watcher's `delivered` ack, leaves the ask `collected` with no turn to show for it. The answer is not destroyed: `GET /api/asks/<ticket>` still returns it, and Hermes' own interrupted-turn auto-continue does not apply because no marker exists. Closing this would need the plugin to wait for the marker, which is deeper coupling to tui_gateway internals than the rest of this change; recorded rather than built.
- `ub_58vs3r` sits `collected`, so the backfill does not touch it; the answer is readable at `GET /api/asks/ub_58vs3r`. Filed asks still `answered` at upgrade time do get a wake.
- tui_gateway internals (`_sessions`, `dispatch`, `prompt.submit` params) are private names. An upstream rename breaks TUI delivery silently: the watcher then reports the session unreachable and the answer waits for `unblock_check`. Worth a canary after each Hermes update.
- Gateway sessions need the config grant above; until set, no wake for Slack/Telegram-originated asks. A second channel exists for gateway-hosted sessions only: the Hermes API server (`gateway/platforms/api_server.py`, `/v1/chat/completions` with `X-Hermes-Session-Id`, bearer `API_SERVER_KEY`), which `gateway/wake.py` itself uses. It could let the daemon wake cross-process without the plugin thread, but it does not reach TUI sessions, so it is not used here.
- Why in-process and not an RPC: a tui_gateway has no inbound listener. Its stdio JSON-RPC belongs to the TUI frontend and `HERMES_TUI_SIDECAR_URL` is publish-only (`tui_gateway/event_publisher.py`). `ctx.inject_message` cannot reach a TUI session either: `_cli_ref` is set only by `hermes chat` (`cli.py:18441`) and the gateway injector is installed only by the main `GatewayRunner` (`gateway/run.py:21070`). The plugin thread inside the tui_gateway process is the only path to that session.
- TUI sessions running under compute-host isolation (`_session_uses_compute_host` in `tui_gateway/server.py`) load plugins in a child process. That child has no `tui_gateway.server` in `sys.modules`, so the watcher reports the session unreachable and the answer waits for `unblock_check`. The incident session was a plain TUI session, which is covered.
- The `web/dist` copy change is not built here.
- Any holder of the daemon bearer secret can claim wakes for any `session_id` it names. That is the daemon's existing trust model (`/api/pending` and `/api/asks/:t/collect` already work this way): the secret is a 0600 file for local clients, and the browser never sees it. Not changed here.
