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
    profile = _session_env("HERMES_SESSION_PROFILE")
    if profile:
        origin["profiles"] = [profile]
    return {key: value for key, value in origin.items() if value not in (None, "", [])}


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
        raise RuntimeError(
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


def unblock_file(args: Mapping[str, Any], **_kwargs: Any) -> Dict[str, Any]:
    """File a nonblocking ask in the canonical Unblock queue."""

    result = _create("file", args)
    result["message"] = "Filed %s. Keep working; call unblock_check later." % result["ticket"]
    return result


def unblock_park(args: Mapping[str, Any], **_kwargs: Any) -> Dict[str, Any]:
    """File a gating ask and wait until the user answers it in Unblock."""

    created = _create("park", args)
    ticket = created["ticket"]
    ttl = args.get("ttl_seconds")
    deadline = time.monotonic() + (float(ttl) if ttl else 24 * 60 * 60)
    while time.monotonic() < deadline:
        current = _api("/asks/" + urllib.parse.quote(ticket))
        if current.get("status") in ("answered", "bounced"):
            collected = _api(
                "/asks/%s/collect" % urllib.parse.quote(ticket), {}, method="POST"
            )["ask"]
            return {
                "ticket": ticket,
                "url": created["url"],
                "ask": collected,
                "message": _answer_text(collected),
            }
        if current.get("status") in ("cancelled", "expired", "orphaned"):
            raise RuntimeError("ask %s is %s" % (ticket, current["status"]))
        time.sleep(3)
    raise RuntimeError("timed out waiting for %s" % ticket)


def unblock_check(_args: Mapping[str, Any], **_kwargs: Any) -> Dict[str, Any]:
    """Collect answered filed asks owned by the current Hermes session."""

    query = urllib.parse.urlencode(_origin(), doseq=True)
    pending = _api("/pending?" + query).get("asks", [])
    collected: List[Dict[str, Any]] = []
    for ask in pending:
        body = _api(
            "/asks/%s/collect" % urllib.parse.quote(ask["ticket"]), {}, method="POST"
        )
        collected.append(body["ask"])
    return {
        "asks": collected,
        "message": "No answered requests are waiting."
        if not collected
        else "\n\n".join(_answer_text(ask) for ask in collected),
    }


def unblock_cancel(args: Mapping[str, Any], **_kwargs: Any) -> Dict[str, Any]:
    ticket = str(args["ticket"])
    body = _api(
        "/asks/%s/cancel" % urllib.parse.quote(ticket),
        {"note": args.get("note")},
        method="POST",
    )
    return {"ask": body["ask"], "message": "Cancelled %s." % ticket}
