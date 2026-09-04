"""Wake the Hermes session that filed an ask, once a human answers it.

The daemon owns the promise (a durable `wake` row per answered filed ask).
This module is the Hermes half: a small watcher thread that claims wakes for
the sessions THIS process hosts, hands each answer to the right session as a
message, and acks so the daemon marks the ask collected. Delivery failures
release the lease and the daemon retries later, so a Hermes restart between
"answered" and "delivered" loses nothing.

Three ways a Hermes process can host a session, tried in order:

* tui_gateway (TUI, desktop, dashboard): the session is in the gateway's
  in-memory registry; a `prompt.submit` RPC targeted at it starts a turn when
  idle and queues as the next turn when busy.
* `hermes chat` CLI: one session per process; the plugin manager's
  `inject_message` queues the text as the next input.
* Messaging gateway: `inject_message(session_key=...)`, which Hermes only
  honours when `plugins.entries.unblock.allow_gateway_injection` is true.

A wake is claimed only after a live match, so two Hermes processes never
race for one session and a session hosted nowhere stays owed at the daemon.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import urllib.parse
from typing import Any, Callable, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)

CLAIM_INTERVAL_SECONDS = 5.0
SCAN_INTERVAL_SECONDS = 15.0
DAEMON_DOWN_BACKOFF_SECONDS = 60.0
ARM_TTL_SECONDS = 24 * 60 * 60
LEASE_SECONDS = 90

_context: Any = None


def set_context(ctx: Any) -> None:
    """Remember the plugin context so gateway/CLI delivery can reach Hermes."""

    global _context
    _context = ctx


def wake_text(ticket: str, body: str) -> str:
    return (
        "[unblock] %s was answered in Unblock. The answer is below and is already "
        "collected; do not call unblock_check for it. Act on it now.\n\n%s" % (ticket, body)
    )


class SessionUnreachable(RuntimeError):
    """The session exists at the daemon but this process cannot hand it a message."""


class SessionBusy(SessionUnreachable):
    """The session is mid-turn. A filed answer never interrupts; try again when idle."""


# ------------------------------------------------------------------ delivery


def _origin_matches(session: Mapping[str, Any], origin: Mapping[str, Any]) -> bool:
    key = origin.get("session_key")
    if key and session.get("session_key") == key:
        return True
    sid = origin.get("session_id")
    agent = session.get("agent")
    return bool(sid and getattr(agent, "session_id", None) == sid)


def _tui_server() -> Any:
    """The tui_gateway server module, only if this process already runs it."""

    return sys.modules.get("tui_gateway.server")


def _tui_find(origin: Mapping[str, Any]) -> Optional[tuple]:
    server = _tui_server()
    if server is None:
        return None
    sessions = getattr(server, "_sessions", None)
    if not isinstance(sessions, dict):
        return None
    # The gateway mutates this registry under its own lock; take it when it
    # exists so a resume or reap mid-iteration cannot race the snapshot.
    lock = getattr(server, "_sessions_lock", None)
    if lock is not None and hasattr(lock, "__enter__"):
        with lock:
            snapshot = list(sessions.items())
    else:
        snapshot = list(sessions.items())
    for sid, session in snapshot:
        if isinstance(session, Mapping) and _origin_matches(session, origin):
            return sid, session
    return None


def _cli_ref() -> Any:
    try:
        from hermes_cli.plugins import get_plugin_manager

        return getattr(get_plugin_manager(), "_cli_ref", None)
    except Exception:
        return None


def _cli_hosts(origin: Mapping[str, Any]) -> bool:
    cli = _cli_ref()
    if cli is None:
        return False
    agent = getattr(cli, "agent", None)
    sid = getattr(agent, "session_id", None)
    return bool(sid and sid == origin.get("session_id"))


def _gateway_can_inject(origin: Mapping[str, Any]) -> bool:
    if not origin.get("session_key") or _context is None:
        return False
    try:
        allowed = getattr(_context, "_gateway_injection_allowed", None)
        manager = getattr(_context, "_manager", None)
        return bool(
            callable(allowed)
            and allowed()
            and getattr(manager, "has_gateway_message_injector", False)
        )
    except Exception:
        return False


def _tui_running(session: Mapping[str, Any]) -> bool:
    """Whether a turn is in flight, read under the session's own lock when it has one."""

    lock = session.get("history_lock")
    if lock is not None and hasattr(lock, "__enter__"):
        with lock:
            return bool(session.get("running"))
    return bool(session.get("running"))


def _strip_queued_text(queued_text: str, text: str) -> Optional[str]:
    """Remove `text` from a queued entry. None when it is not there.

    tui_gateway merges consecutive text-only queued prompts as
    "{earlier}\\n\\n{later}", so the wake may be a segment of a larger string.
    """

    if queued_text == text:
        return ""
    for candidate in (text + "\n\n", "\n\n" + text):
        if candidate in queued_text:
            return queued_text.replace(candidate, "", 1)
    return None


def _tui_unqueue(session: Any, text: str) -> bool:
    """Withdraw our text from the session's memory-only prompt queue.

    Mirrors `_enqueue_prompt` in tui_gateway/server.py: one slot in
    `queued_prompt` plus overflow in `queued_prompts`. Returns True when a copy
    was found and removed. Done under the session's history lock, the same
    lock the gateway takes to drain the queue.
    """

    lock = session.get("history_lock")
    if lock is None or not hasattr(lock, "__enter__"):
        lock = threading.Lock()
    with lock:
        removed = False
        entry = session.get("queued_prompt")
        if isinstance(entry, Mapping) and isinstance(entry.get("text"), str) and not entry.get("image_paths"):
            remaining = _strip_queued_text(entry["text"], text)
            if remaining is not None:
                removed = True
                if remaining.strip():
                    entry["text"] = remaining
                else:
                    overflow = session.get("queued_prompts") or []
                    session["queued_prompt"] = overflow.pop(0) if overflow else None
                    if session.get("queued_prompt") is None:
                        session.pop("queued_prompt", None)
        overflow = session.get("queued_prompts")
        if isinstance(overflow, list):
            kept = []
            for item in overflow:
                if (
                    not removed
                    and isinstance(item, Mapping)
                    and isinstance(item.get("text"), str)
                    and not item.get("image_paths")
                ):
                    remaining = _strip_queued_text(item["text"], text)
                    if remaining is not None:
                        removed = True
                        if remaining.strip():
                            item["text"] = remaining
                            kept.append(item)
                        continue
                kept.append(item)
            session["queued_prompts"] = kept
            if not kept:
                session.pop("queued_prompts", None)
        return removed


class HermesDelivery:
    """Find the live session behind an origin and hand it a message."""

    def reachable(self, origin: Mapping[str, Any]) -> bool:
        """True only when a delivery attempted now would land.

        A busy TUI session is not reachable: `prompt.submit` mid-turn either
        interrupts the live turn (the default policy) or parks the text in a
        memory-only queue that a crash drops, and neither is an acceptable
        fate for an answer the daemon has just marked collected. Wait for idle.
        """

        found = _tui_find(origin)
        if found is not None:
            return not _tui_running(found[1])
        return _cli_hosts(origin) or _gateway_can_inject(origin)

    def deliver(self, origin: Mapping[str, Any], text: str) -> str:
        """Deliver, returning the channel used. Raises SessionUnreachable."""

        found = _tui_find(origin)
        if found is not None:
            sid, session = found
            if _tui_running(session):
                raise SessionBusy("tui session is mid-turn; retry when idle")
            server = _tui_server()
            request = {
                "jsonrpc": "2.0",
                "id": "unblock-wake-%d" % int(time.time() * 1000),
                "method": "prompt.submit",
                # `queued` pins the busy policy to queue-only, so if a turn
                # starts between the idle check above and the gateway's own
                # check, the wake can never interrupt or redirect that turn.
                "params": {"session_id": sid, "text": text, "queued": True},
            }
            try:
                response = server.dispatch(request, session.get("transport"))
            except Exception as error:  # pragma: no cover - defensive
                raise SessionUnreachable("tui prompt.submit failed: %s" % error) from error
            if not isinstance(response, Mapping):
                raise SessionUnreachable("tui prompt.submit returned no response")
            if response.get("error"):
                raise SessionUnreachable(
                    "tui prompt.submit rejected: %s" % json.dumps(response["error"])
                )
            result = response.get("result")
            status = result.get("status") if isinstance(result, Mapping) else None
            if status == "streaming":
                # An accepted turn: the session took the text.
                return "tui"
            if status in ("steered", "redirected"):
                # The live turn already received the text; cannot happen with
                # queued=True, but if it did, a retry would be a duplicate.
                return "tui"
            if status == "queued":
                # A turn started between the idle check and the gateway's own.
                # The text now sits in a memory-only queue that a crash drops,
                # so it is not delivered. Take the copy back out, then leave
                # the wake owed: the next idle pass sends it for real, once.
                if _tui_unqueue(session, text):
                    raise SessionBusy("tui session went busy; queued copy withdrawn, retry when idle")
                # The copy is gone already, which means the queue drained and
                # the text is running as a turn: that is a delivery.
                return "tui"
            raise SessionUnreachable("tui prompt.submit returned status=%r" % status)

        if _cli_hosts(origin) and _context is not None:
            if _context.inject_message(text):
                return "cli"
            raise SessionUnreachable("cli inject_message refused the wake")

        if _gateway_can_inject(origin):
            if _context.inject_message(text, session_key=origin["session_key"]):
                return "gateway"
            raise SessionUnreachable("gateway inject_message refused the wake")

        raise SessionUnreachable("session is not hosted by this Hermes process")


# ------------------------------------------------------------------ watcher


class WakeWatcher:
    """Claim, deliver and ack wakes for the sessions this process hosts.

    `api(path, body=None, method=None)` is the daemon client; `deliver` turns a
    wake into a message in the right session. `render` builds the message body
    from the collected ask. Everything is injected so the loop is testable
    without Hermes or a real daemon.
    """

    def __init__(
        self,
        api: Callable[..., Any],
        delivery: Any,
        render: Callable[[Mapping[str, Any]], str],
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._api = api
        self._delivery = delivery
        self._render = render
        self._clock = clock
        self._lock = threading.Lock()
        self._armed: Dict[str, Dict[str, Any]] = {}
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._next_scan = 0.0
        self._daemon_down_until = 0.0
        self.delivered: List[str] = []

    # -- arming ------------------------------------------------------------

    def arm(self, origin: Mapping[str, Any]) -> bool:
        """Watch for wakes owed to this exact session. Returns False if it has no identity."""

        key = origin.get("session_id") or origin.get("pane_id")
        if not key:
            return False
        with self._lock:
            self._armed[key] = {
                "origin": dict(origin),
                "until": self._clock() + ARM_TTL_SECONDS,
            }
        return True

    def armed(self) -> List[str]:
        with self._lock:
            return sorted(self._armed)

    def _disarm(self, key: str) -> None:
        with self._lock:
            self._armed.pop(key, None)

    # -- thread ------------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="unblock-wake", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                logger.debug("unblock wake tick failed", exc_info=True)
            self._stop.wait(CLAIM_INTERVAL_SECONDS)

    # -- one pass ----------------------------------------------------------

    def tick(self) -> int:
        """One pass: recovery scan, then claim/deliver/ack per armed session. Returns deliveries."""

        now = self._clock()
        if now < self._daemon_down_until:
            return 0
        delivered = 0
        try:
            if now >= self._next_scan:
                self._next_scan = now + SCAN_INTERVAL_SECONDS
                self._scan()
            with self._lock:
                targets = list(self._armed.items())
            for key, entry in targets:
                if entry["until"] < now:
                    self._disarm(key)
                    continue
                delivered += self._service(key, entry["origin"])
        except DaemonUnavailable:
            self._daemon_down_until = self._clock() + DAEMON_DOWN_BACKOFF_SECONDS
        return delivered

    def _scan(self) -> None:
        """Arm any owed session this process can reach. This is the restart recovery path."""

        owed = self._api("/wakes").get("wakes") or []
        for wake in owed:
            origin = wake.get("origin") or {}
            if origin.get("agent") != "hermes":
                continue
            key = origin.get("session_id")
            if not key:
                continue
            with self._lock:
                already = key in self._armed
            if already:
                continue
            if self._delivery.reachable(origin):
                self.arm(origin)

    def _service(self, key: str, origin: Mapping[str, Any]) -> int:
        # Claim only when a delivery would land right now. A busy or absent
        # session is left owed at the daemon at no cost; claiming first would
        # burn attempts and lease time on a session that cannot take the text.
        if not self._delivery.reachable(origin):
            return 0
        claim = self._api("/wakes/claim", {"origin": origin, "lease_seconds": LEASE_SECONDS})
        wakes = claim.get("wakes") or []
        count = 0
        for wake in wakes:
            ask = wake.get("ask") or {}
            ticket = ask.get("ticket") or wake.get("ticket")
            token = wake.get("claim_token")
            try:
                channel = self._delivery.deliver(origin, wake_text(ticket, self._render(ask)))
            except SessionUnreachable as error:
                self._api(
                    "/wakes/%s/ack" % urllib.parse.quote(ticket),
                    {"claim_token": token, "delivered": False, "error": str(error)},
                )
                continue
            self._api(
                "/wakes/%s/ack" % urllib.parse.quote(ticket),
                {"claim_token": token, "delivered": True},
            )
            self.delivered.append(ticket)
            logger.info("unblock: delivered %s to session %s via %s", ticket, key, channel)
            count += 1
        if not wakes and not claim.get("outstanding"):
            # Nothing open and nothing owed: stop asking about this session
            # until it files again.
            self._disarm(key)
        return count


class DaemonUnavailable(RuntimeError):
    """Raised by the api callable when the daemon cannot be reached."""


_watcher: Optional[WakeWatcher] = None
_watcher_lock = threading.Lock()


def watcher(api: Callable[..., Any], render: Callable[[Mapping[str, Any]], str]) -> WakeWatcher:
    """The process-wide watcher, started on first use unless UNBLOCK_HERMES_WAKE=0."""

    global _watcher
    with _watcher_lock:
        if _watcher is None:
            _watcher = WakeWatcher(api, HermesDelivery(), render)
        if os.environ.get("UNBLOCK_HERMES_WAKE", "1") != "0":
            _watcher.start()
        return _watcher
