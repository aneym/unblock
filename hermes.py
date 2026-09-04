"""First-party Hermes client for the standalone Unblock service.

Unblock owns the daemon, API, database, and UI. This module is only a native
Hermes edge: it translates tool calls into the canonical local HTTP API and
reads session identity at call time so concurrent Hermes sessions never share
an agent key accidentally.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

try:  # loaded by Hermes as the `unblock` package
    from . import wake as _wake
except ImportError:  # imported flat, as the tests do
    import wake as _wake  # type: ignore[no-redef]

HOST = "127.0.0.1"
DEFAULT_PORT = 4488


def _state_dir() -> Path:
    configured = os.environ.get("UNBLOCK_STATE_DIR")
    if configured:
        return Path(configured).expanduser()
    base = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state"))
    return base / "unblock"


def _daemon_record() -> Dict[str, Any]:
    try:
        value = json.loads((_state_dir() / "daemon.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _daemon_port() -> int:
    record = _daemon_record()
    return int(os.environ.get("UNBLOCK_PORT") or record.get("port") or DEFAULT_PORT)


def _daemon_auth() -> Optional[str]:
    value = os.environ.get("UNBLOCK_AUTH") or _daemon_record().get("auth")
    return str(value) if value else None


def _session_env(name: str, default: str = "") -> str:
    """Read Hermes' task-local session context, with CLI env fallback."""

    try:
        from gateway.session_context import get_session_env

        return str(get_session_env(name, default) or default)
    except Exception:
        return str(os.environ.get(name, default) or default)


def _origin() -> Dict[str, Any]:
    origin: Dict[str, Any] = {
        "agent": "hermes",
        "session_id": _session_env("HERMES_SESSION_ID"),
        "cwd": os.getcwd(),
    }
    # Hermes keys a live TUI session by session_key and records it in
    # state.db by session_id. A wake needs whichever name the host answers
    # to, so both travel; only session_id identifies the agent to the queue.
    key = _session_env("HERMES_SESSION_KEY")
    if key and key != origin["session_id"]:
        origin["session_key"] = key
    profile = _session_env("HERMES_SESSION_PROFILE")
    if profile:
        origin["profiles"] = [profile]
    return {key: value for key, value in origin.items() if value not in (None, "", [])}


def _result(payload: Mapping[str, Any]) -> str:
    """Hermes accepts only a string from a tool handler.

    The registry rejects a dict outright (`tool_result_contract`), which is
    how `unblock_file` filed a ticket the agent never heard about. JSON keeps
    the structure for the model while satisfying the contract.
    """

    return json.dumps(dict(payload), ensure_ascii=False)


def _watcher() -> "_wake.WakeWatcher":
    return _wake.watcher(_api, _answer_text)


def _arm_current_session() -> None:
    """Make sure the wake watcher is listening for this session's answers."""

    try:
        _watcher().arm(_origin())
    except Exception:  # never let the watcher break a tool call
        pass


def _api(path: str, body: Optional[Mapping[str, Any]] = None, method: Optional[str] = None) -> Any:
    headers = {"Content-Type": "application/json"}
    auth = _daemon_auth()
    if auth:
        headers["Authorization"] = "Bearer " + auth
    payload = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        "http://%s:%s/api%s" % (HOST, _daemon_port(), path),
        data=payload,
        headers=headers,
        method=method or ("POST" if body is not None else "GET"),
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode("utf-8")).get("error")
        except Exception:
            detail = None
        raise RuntimeError(detail or "Unblock API returned HTTP %s" % error.code) from error
    except OSError as error:
        raise _wake.DaemonUnavailable(
            "Unblock daemon is unavailable. Start the standalone service with "
            "`node bin/unblock.js daemon start`."
        ) from error


def _answer_url(ticket: str) -> str:
    health = _api("/health")
    public_origin = health.get("public_origin") if isinstance(health, dict) else None
    if public_origin:
        return str(public_origin).rstrip("/") + "/#ask=" + urllib.parse.quote(ticket)
    link = _api("/links", {"ticket": ticket, "ttl_seconds": 900})
    return str(link["url"])


def _create(kind: str, args: Mapping[str, Any]) -> Dict[str, Any]:
    ask = _api("/asks", {"ask": dict(args, kind=kind), "origin": _origin()})
    return {"ticket": ask["ticket"], "url": _answer_url(ask["ticket"]), "ask": ask}


def _answer_text(ask: Mapping[str, Any]) -> str:
    if ask.get("status") == "bounced":
        return "%s was SENT BACK: %s" % (ask["ticket"], ask.get("reply") or "(no note)")
    lines = ["%s: %s" % (ask["ticket"], ask["title"])]
    answers = ask.get("answers") or {}
    contexts = ask.get("field_context") or {}
    references = ask.get("answer_is_ref") or {}
    for field in ask.get("fields") or []:
        name = field["name"]
        if name not in answers:
            continue
        value = answers[name]
        if references.get(name) and isinstance(value, dict):
            lines.append("%s: %s reference %s" % (name, value.get("store"), value.get("ref")))
            if value.get("resolve"):
                lines.append("  Resolve without printing: %s" % value["resolve"])
        elif value is None:
            lines.append("%s: (skipped — they chose not to answer)" % name)
        elif isinstance(value, dict) and "$bounce" in value:
            note = value.get("$bounce") or "no note"
            if "value" in value:
                # A bounce that carries an answer: use it as a draft, then
                # re-ask with their note addressed before acting on it.
                lines.append(
                    "%s: %s — SENT BACK for rework — %s"
                    % (name, json.dumps(value["value"]), note)
                )
                lines.append(
                    "  Their value stands as a draft. Re-ask this question before you act on it."
                )
            else:
                lines.append("%s: SENT BACK, not answered — %s" % (name, note))
        else:
            lines.append("%s: %s" % (name, json.dumps(value)))
        if contexts.get(name):
            lines.append("  their context: %s" % contexts[name])
    if ask.get("reply"):
        lines.append("they also said: %s" % ask["reply"])
    return "\n".join(lines)


def unblock_file(args: Mapping[str, Any], **_kwargs: Any) -> str:
    """File a nonblocking ask in the canonical Unblock queue."""

    result = _create("file", args)
    _arm_current_session()
    result["message"] = (
        "Filed %s. Keep working. When it is answered the answer arrives in this "
        "session as an [unblock] message; unblock_check also collects it."
        % result["ticket"]
    )
    return _result(result)


def unblock_park(args: Mapping[str, Any], **_kwargs: Any) -> str:
    """File a gating ask and wait until the user answers it in Unblock."""

    created = _create("park", args)
    ticket = created["ticket"]
    ttl = args.get("ttl_seconds")
    deadline = time.monotonic() + (float(ttl) if ttl else 24 * 60 * 60)
    while time.monotonic() < deadline:
        current = _api("/asks/" + urllib.parse.quote(ticket))
        if current.get("status") in ("answered", "bounced"):
            # Render before collecting: a collect that succeeds and a result
            # that is then lost would strand the answer as "collected".
            message = _answer_text(current)
            collected = _api(
                "/asks/%s/collect" % urllib.parse.quote(ticket), {}, method="POST"
            )["ask"]
            _arm_current_session()
            return _result(
                {"ticket": ticket, "url": created["url"], "ask": collected, "message": message}
            )
        if current.get("status") in ("cancelled", "expired", "orphaned"):
            raise RuntimeError("ask %s is %s" % (ticket, current["status"]))
        time.sleep(3)
    raise RuntimeError("timed out waiting for %s" % ticket)


def unblock_check(_args: Mapping[str, Any], **_kwargs: Any) -> str:
    """Collect answered filed asks owned by the current Hermes session."""

    query = urllib.parse.urlencode(_origin(), doseq=True)
    pending = _api("/pending?" + query).get("asks", [])
    collected: List[Dict[str, Any]] = []
    messages: List[str] = []
    for ask in pending:
        # Same order as park: the text exists before the daemon forgets the
        # answer is uncollected. Collecting also voids the pending wake, so
        # the answer is never delivered twice.
        messages.append(_answer_text(ask))
        body = _api(
            "/asks/%s/collect" % urllib.parse.quote(ask["ticket"]), {}, method="POST"
        )
        collected.append(body["ask"])
    _arm_current_session()
    return _result(
        {
            "asks": collected,
            "message": "No answered requests are waiting."
            if not collected
            else "\n\n".join(messages),
        }
    )


def unblock_cancel(args: Mapping[str, Any], **_kwargs: Any) -> str:
    ticket = str(args["ticket"])
    body = _api(
        "/asks/%s/cancel" % urllib.parse.quote(ticket),
        {"note": args.get("note")},
        method="POST",
    )
    return _result({"ask": body["ask"], "message": "Cancelled %s." % ticket})
