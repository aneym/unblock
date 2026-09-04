import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# The watcher thread is exercised by calling tick() directly.
os.environ["UNBLOCK_HERMES_WAKE"] = "0"


class FakeQueueHandler(BaseHTTPRequestHandler):
    asks = {}
    wakes = {}  # ticket -> {"status", "claim_token", "attempts", "acks": [...]}
    calls = []

    def log_message(self, format, *args):
        return

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        type(self).calls.append(("GET", self.path, None, self.headers.get("Authorization")))
        if self.path == "/api/health":
            return self._json(200, {"ok": True, "version": "0.1.0", "public_origin": None})
        if self.path.startswith("/api/pending?"):
            return self._json(200, {"asks": [ask for ask in self.asks.values() if ask["status"] == "answered"]})
        if self.path == "/api/wakes":
            owed = []
            for ticket, wake in self.wakes.items():
                if wake["status"] != "pending":
                    continue
                ask = self.asks[ticket]
                owed.append({"ticket": ticket, "status": "pending", "origin": ask["origin"]})
            return self._json(200, {"wakes": owed})
        ticket = self.path.removeprefix("/api/asks/")
        if ticket in self.asks:
            return self._json(200, self.asks[ticket])
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size) or b"{}")
        type(self).calls.append(("POST", self.path, body, self.headers.get("Authorization")))
        if self.path == "/api/asks":
            ticket = "ub_testticket"
            ask = {
                "ticket": ticket,
                "kind": body["ask"]["kind"],
                "purpose": body["ask"].get("purpose", "blocker"),
                "title": body["ask"]["title"],
                "why": body["ask"]["why"],
                "fields": body["ask"]["fields"],
                "answers": {},
                "origin": body["origin"],
                "status": "open",
                "created_at": 1,
            }
            self.asks[ticket] = ask
            return self._json(201, ask)
        port = int(getattr(self.server, "server_port"))
        if self.path == "/api/links":
            return self._json(201, {"url": f"http://127.0.0.1:{port}/u/link-token", "expires_at": 999})
        if self.path.endswith("/cancel"):
            ticket = self.path.split("/")[3]
            self.asks[ticket]["status"] = "cancelled"
            return self._json(200, {"ask": self.asks[ticket]})
        if self.path.endswith("/collect"):
            ticket = self.path.split("/")[3]
            ask = self.asks[ticket]
            ask["status"] = "collected"
            if ticket in self.wakes and self.wakes[ticket]["status"] == "pending":
                self.wakes[ticket]["status"] = "void"
            return self._json(200, {"ask": ask})
        if self.path == "/api/wakes/claim":
            origin = body["origin"]
            claimed = []
            for ticket, wake in self.wakes.items():
                ask = self.asks[ticket]
                if wake["status"] != "pending" or wake.get("claim_token"):
                    continue
                if ask["origin"].get("session_id") != origin.get("session_id"):
                    continue
                wake["claim_token"] = f"tok-{ticket}-{wake['attempts']}"
                wake["attempts"] += 1
                claimed.append({"ticket": ticket, "claim_token": wake["claim_token"], "attempts": wake["attempts"], "ask": ask})
            outstanding = sum(
                1
                for ask in self.asks.values()
                if ask["kind"] == "file"
                and ask["status"] == "open"
                and ask["origin"].get("session_id") == origin.get("session_id")
            )
            return self._json(200, {"wakes": claimed, "outstanding": outstanding})
        if self.path.startswith("/api/wakes/") and self.path.endswith("/ack"):
            ticket = self.path.split("/")[3]
            wake = self.wakes[ticket]
            wake["acks"].append(body)
            if wake["status"] != "pending":
                return self._json(200, {"wake": wake, "ask": self.asks[ticket]})
            if body.get("claim_token") != wake.get("claim_token"):
                return self._json(409, {"error": "wake lease is not yours"})
            if body.get("delivered"):
                wake["status"] = "delivered"
                self.asks[ticket]["status"] = "collected"
            else:
                wake["claim_token"] = None
                wake["last_error"] = body.get("error")
            return self._json(200, {"wake": wake, "ask": self.asks[ticket]})
        return self._json(404, {"error": "not found"})


def answered_ask(ticket, session, **origin_extra):
    return {
        "ticket": ticket,
        "kind": "file",
        "purpose": "decision",
        "title": "Done",
        "why": "why",
        "fields": [{"name": "answer", "type": "text", "label": "Answer"}],
        "answers": {"answer": "Use buyer calls"},
        "field_context": {},
        "origin": {"agent": "hermes", "session_id": session, **origin_extra},
        "status": "answered",
        "created_at": 1,
    }


def owed(ticket):
    return {"status": "pending", "claim_token": None, "attempts": 0, "acks": []}


class HermesPluginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeQueueHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        FakeQueueHandler.asks = {}
        FakeQueueHandler.wakes = {}
        FakeQueueHandler.calls = []
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        (self.state / "daemon.json").write_text(
            json.dumps({"port": self.server.server_port, "auth": "test-auth"})
        )
        self.env = mock.patch.dict(
            os.environ,
            {
                "UNBLOCK_STATE_DIR": str(self.state),
                "HERMES_SESSION_ID": "session-123",
                "HERMES_SESSION_KEY": "tui-key-123",
                "HERMES_SESSION_SOURCE": "tui",
                "HERMES_SESSION_PROFILE": "bot",
            },
            clear=False,
        )
        self.env.start()
        import wake

        wake._watcher = None
        wake.set_context(None)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    # -- handler contract -------------------------------------------------

    def test_file_uses_dynamic_hermes_origin_and_returns_a_json_string(self):
        import hermes

        raw = hermes.unblock_file(
            {
                "purpose": "decision",
                "title": "Founder direction",
                "why": "The pre-read needs Alex's judgment.",
                "fields": [
                    {
                        "name": "direction",
                        "type": "text",
                        "label": "Direction",
                        "recommend": {"value": "Start with buyer calls", "why": "Fastest paid evidence."},
                    }
                ],
            }
        )

        # Hermes' registry accepts only a string; a dict is a contract error.
        self.assertIsInstance(raw, str)
        result = json.loads(raw)
        self.assertEqual(result["ticket"], "ub_testticket")
        self.assertIn("/u/link-token", result["url"])
        self.assertIn("arrives in this session", result["message"])
        create = next(call for call in FakeQueueHandler.calls if call[1] == "/api/asks")
        self.assertEqual(create[2]["origin"]["agent"], "hermes")
        self.assertEqual(create[2]["origin"]["session_id"], "session-123")
        self.assertEqual(create[2]["origin"]["session_key"], "tui-key-123")
        self.assertEqual(create[2]["origin"]["profiles"], ["bot"])
        self.assertNotIn("pane_id", create[2]["origin"])
        self.assertEqual(create[3], "Bearer test-auth")
        # Filing arms the watcher for exactly this session.
        self.assertEqual(hermes._watcher().armed(), ["session-123"])

    def test_every_handler_returns_a_string(self):
        import hermes

        FakeQueueHandler.asks["ub_done"] = answered_ask("ub_done", "session-123")
        self.assertIsInstance(hermes.unblock_check({}), str)
        self.assertIsInstance(hermes.unblock_cancel({"ticket": "ub_done"}), str)
        FakeQueueHandler.asks["ub_park"] = dict(answered_ask("ub_park", "session-123"), kind="park")
        with mock.patch.object(hermes, "_create", return_value={"ticket": "ub_park", "url": "u", "ask": {}}):
            self.assertIsInstance(hermes.unblock_park({"title": "t", "why": "w", "fields": []}), str)

    def test_check_renders_before_collecting_and_collects_for_the_current_session(self):
        import hermes

        FakeQueueHandler.asks["ub_done"] = answered_ask("ub_done", "session-123")

        result = json.loads(hermes.unblock_check({}))

        self.assertEqual([ask["ticket"] for ask in result["asks"]], ["ub_done"])
        self.assertIn("answer: \"Use buyer calls\"", result["message"])
        pending_call = next(call for call in FakeQueueHandler.calls if call[1].startswith("/api/pending?"))
        self.assertIn("agent=hermes", pending_call[1])
        self.assertIn("session_id=session-123", pending_call[1])
        self.assertTrue(any(call[1] == "/api/asks/ub_done/collect" for call in FakeQueueHandler.calls))

    # -- wake watcher -----------------------------------------------------

    def _watcher_with(self, delivery):
        import hermes
        import wake

        return wake.WakeWatcher(hermes._api, delivery, hermes._answer_text)

    def test_tick_claims_delivers_and_acks_for_the_armed_session_only(self):
        import wake

        FakeQueueHandler.asks["ub_mine"] = answered_ask("ub_mine", "session-123")
        FakeQueueHandler.asks["ub_other"] = answered_ask("ub_other", "session-999")
        FakeQueueHandler.wakes["ub_mine"] = owed("ub_mine")
        FakeQueueHandler.wakes["ub_other"] = owed("ub_other")

        delivered = []

        class Delivery:
            def reachable(self, origin):
                return origin["session_id"] == "session-123"

            def deliver(self, origin, text):
                delivered.append((origin["session_id"], text))
                return "test"

        watcher = self._watcher_with(Delivery())
        watcher.arm({"agent": "hermes", "session_id": "session-123", "session_key": "tui-key-123"})
        # Armed but unreachable (busy, or hosted elsewhere): never claimed.
        watcher.arm({"agent": "hermes", "session_id": "session-999"})

        self.assertEqual(watcher.tick(), 1)
        claims = [call[2]["origin"]["session_id"] for call in FakeQueueHandler.calls if call[1] == "/api/wakes/claim"]
        self.assertEqual(claims, ["session-123"])
        self.assertEqual([session for session, _ in delivered], ["session-123"])
        text = delivered[0][1]
        self.assertTrue(text.startswith("[unblock] ub_mine was answered"))
        self.assertIn("Use buyer calls", text)
        self.assertEqual(FakeQueueHandler.wakes["ub_mine"]["status"], "delivered")
        self.assertEqual(FakeQueueHandler.asks["ub_mine"]["status"], "collected")
        # The other session's wake is untouched: never claimed, never delivered.
        self.assertEqual(FakeQueueHandler.wakes["ub_other"]["status"], "pending")
        self.assertIsNone(FakeQueueHandler.wakes["ub_other"]["claim_token"])
        self.assertEqual(FakeQueueHandler.wakes["ub_mine"]["acks"], [{"claim_token": "tok-ub_mine-0", "delivered": True}])
        # A second tick delivers nothing twice, and with nothing open and
        # nothing owed it disarms the session until it files again.
        self.assertEqual(watcher.armed(), ["session-123", "session-999"])
        self.assertEqual(watcher.tick(), 0)
        self.assertEqual(len(delivered), 1)
        self.assertEqual(watcher.armed(), ["session-999"])

    def test_failed_delivery_releases_the_lease_and_is_retried(self):
        import wake

        FakeQueueHandler.asks["ub_retry"] = answered_ask("ub_retry", "session-123")
        FakeQueueHandler.wakes["ub_retry"] = owed("ub_retry")
        attempts = {"n": 0}

        class Flaky:
            def reachable(self, origin):
                return True

            def deliver(self, origin, text):
                attempts["n"] += 1
                if attempts["n"] == 1:
                    raise wake.SessionUnreachable("session not live here")
                return "tui"

        watcher = self._watcher_with(Flaky())
        watcher.arm({"agent": "hermes", "session_id": "session-123"})

        self.assertEqual(watcher.tick(), 0)
        wake_row = FakeQueueHandler.wakes["ub_retry"]
        self.assertEqual(wake_row["status"], "pending")
        self.assertEqual(wake_row["last_error"], "session not live here")
        self.assertIsNone(wake_row["claim_token"])
        self.assertEqual(FakeQueueHandler.asks["ub_retry"]["status"], "answered")

        # Still armed because the wake is still owed; the next pass wins.
        self.assertEqual(watcher.armed(), ["session-123"])
        self.assertEqual(watcher.tick(), 1)
        self.assertEqual(wake_row["status"], "delivered")
        self.assertEqual(wake_row["attempts"], 2)

    def test_recovery_scan_arms_only_sessions_this_process_can_reach(self):
        FakeQueueHandler.asks["ub_here"] = answered_ask("ub_here", "session-here")
        FakeQueueHandler.asks["ub_elsewhere"] = answered_ask("ub_elsewhere", "session-elsewhere")
        FakeQueueHandler.asks["ub_claude"] = dict(answered_ask("ub_claude", "claude-1"), origin={"agent": "claude", "session_id": "claude-1"})
        for ticket in ("ub_here", "ub_elsewhere", "ub_claude"):
            FakeQueueHandler.wakes[ticket] = owed(ticket)
        delivered = []

        class Delivery:
            def reachable(self, origin):
                return origin["session_id"] == "session-here"

            def deliver(self, origin, text):
                delivered.append(origin["session_id"])
                return "tui"

        watcher = self._watcher_with(Delivery())
        self.assertEqual(watcher.armed(), [])
        self.assertEqual(watcher.tick(), 1)
        self.assertEqual(delivered, ["session-here"])
        self.assertEqual(FakeQueueHandler.wakes["ub_elsewhere"]["status"], "pending")
        self.assertEqual(FakeQueueHandler.wakes["ub_claude"]["status"], "pending")
        # The scan read the owed list without answers being requested for
        # sessions it cannot reach: only session-here was ever claimed.
        claims = [call[2]["origin"]["session_id"] for call in FakeQueueHandler.calls if call[1] == "/api/wakes/claim"]
        self.assertEqual(claims, ["session-here"])

    def test_daemon_outage_backs_off_instead_of_raising(self):
        import hermes
        import wake

        (self.state / "daemon.json").write_text(json.dumps({"port": 1, "auth": "x"}))
        watcher = self._watcher_with(mock.Mock())
        watcher.arm({"agent": "hermes", "session_id": "session-123"})
        self.assertEqual(watcher.tick(), 0)
        self.assertGreater(watcher._daemon_down_until, 0)

    # -- delivery adapters ------------------------------------------------

    def test_tui_delivery_targets_the_matching_live_session(self):
        import wake

        dispatched = []
        agent = types.SimpleNamespace(session_id="session-123")
        fake_server = types.ModuleType("tui_gateway.server")
        fake_server._sessions = {
            "runtime-A": {"session_key": "other-key", "agent": types.SimpleNamespace(session_id="session-zzz"), "transport": "tA", "running": False, "history_lock": threading.Lock()},
            "runtime-B": {"session_key": "tui-key-123", "agent": agent, "transport": "tB", "running": False, "history_lock": threading.Lock()},
        }
        # The gateway guards its registry with a reentrant lock; the lookup
        # must take it for the snapshot and release it again.
        entries = {"n": 0}

        class RecordingLock:
            def __init__(self):
                self._lock = threading.RLock()

            def __enter__(self):
                entries["n"] += 1
                return self._lock.__enter__()

            def __exit__(self, *exc):
                return self._lock.__exit__(*exc)

        fake_server._sessions_lock = RecordingLock()

        def dispatch(request, transport=None):
            dispatched.append((request, transport))
            return {"jsonrpc": "2.0", "id": request["id"], "result": {"status": "streaming"}}

        fake_server.dispatch = dispatch
        delivery = wake.HermesDelivery()
        origin = {"agent": "hermes", "session_id": "session-123", "session_key": "tui-key-123"}
        with mock.patch.dict(sys.modules, {"tui_gateway.server": fake_server}):
            self.assertTrue(delivery.reachable(origin))
            self.assertFalse(delivery.reachable({"agent": "hermes", "session_id": "nope", "session_key": "nope"}))
            self.assertEqual(delivery.deliver(origin, "hello"), "tui")
            # Matching by durable session_id alone also works (no session_key on file).
            self.assertEqual(delivery.deliver({"agent": "hermes", "session_id": "session-123"}, "again"), "tui")
        self.assertGreaterEqual(entries["n"], 4)
        self.assertFalse(fake_server._sessions_lock._lock._is_owned())
        self.assertEqual(len(dispatched), 2)
        request, transport = dispatched[0]
        self.assertEqual(request["method"], "prompt.submit")
        # `queued` pins the busy policy to queue-only: a wake that loses the
        # idle race can never interrupt or redirect the live turn.
        self.assertEqual(request["params"], {"session_id": "runtime-B", "text": "hello", "queued": True})
        self.assertEqual(transport, "tB")

    def test_tui_delivery_waits_for_an_idle_session(self):
        import wake

        dispatched = []
        fake_server = types.ModuleType("tui_gateway.server")
        session = {"session_key": "tui-key-123", "agent": None, "running": True, "history_lock": threading.Lock()}
        fake_server._sessions = {"runtime-B": session}
        fake_server.dispatch = lambda request, transport=None: dispatched.append(request) or {"result": {"status": "streaming"}}
        origin = {"agent": "hermes", "session_key": "tui-key-123"}
        with mock.patch.dict(sys.modules, {"tui_gateway.server": fake_server}):
            delivery = wake.HermesDelivery()
            # Mid-turn: not reachable (so never claimed), and a direct attempt
            # refuses without touching the gateway.
            self.assertFalse(delivery.reachable(origin))
            with self.assertRaises(wake.SessionBusy):
                delivery.deliver(origin, "x")
            self.assertEqual(dispatched, [])
            session["running"] = False
            self.assertTrue(delivery.reachable(origin))
            self.assertEqual(delivery.deliver(origin, "x"), "tui")
        self.assertEqual(len(dispatched), 1)

    def test_tui_delivery_counts_only_a_started_turn_as_delivered(self):
        import wake

        fake_server = types.ModuleType("tui_gateway.server")
        fake_server._sessions = {"runtime-B": {"session_key": "tui-key-123", "agent": None}}
        origin = {"agent": "hermes", "session_key": "tui-key-123"}
        with mock.patch.dict(sys.modules, {"tui_gateway.server": fake_server}):
            # An RPC error is unreachable.
            fake_server.dispatch = lambda request, transport=None: {"error": {"code": 4090, "message": "busy"}}
            with self.assertRaises(wake.SessionUnreachable):
                wake.HermesDelivery().deliver(origin, "x")
            # The live turn took the text: a retry would be a duplicate.
            for status in ("steered", "redirected"):
                fake_server.dispatch = lambda request, transport=None, s=status: {"result": {"status": s}}
                self.assertEqual(wake.HermesDelivery().deliver(origin, "x"), "tui")
            for bad in ({"result": {"status": None}}, {"result": {}}, {}, None):
                fake_server.dispatch = lambda request, transport=None, b=bad: b
                with self.assertRaises(wake.SessionUnreachable):
                    wake.HermesDelivery().deliver(origin, "x")

    def test_tui_delivery_withdraws_a_queued_copy_instead_of_acking_it(self):
        import wake

        fake_server = types.ModuleType("tui_gateway.server")
        session = {"session_key": "tui-key-123", "agent": None, "running": False, "history_lock": threading.Lock()}
        fake_server._sessions = {"runtime-B": session}
        origin = {"agent": "hermes", "session_key": "tui-key-123"}

        def dispatch_and_queue(request, transport=None):
            # A turn started between our idle check and the gateway's: it
            # parks the text in the memory-only queue and says so.
            session["running"] = True
            session["queued_prompt"] = {"text": request["params"]["text"], "transport": transport}
            return {"result": {"status": "queued"}}

        fake_server.dispatch = dispatch_and_queue
        with mock.patch.dict(sys.modules, {"tui_gateway.server": fake_server}):
            with self.assertRaises(wake.SessionBusy):
                wake.HermesDelivery().deliver(origin, "the wake")
            # The copy is gone, so the retry cannot double up with a drain.
            self.assertNotIn("queued_prompt", session)

            # Merged with a user's queued text: only our segment is removed.
            session["running"] = False

            def dispatch_and_merge(request, transport=None):
                session["running"] = True
                session["queued_prompt"] = {"text": "user text\n\n" + request["params"]["text"], "transport": transport}
                session["queued_prompts"] = [{"text": "later user text", "transport": transport}]
                return {"result": {"status": "queued"}}

            fake_server.dispatch = dispatch_and_merge
            with self.assertRaises(wake.SessionBusy):
                wake.HermesDelivery().deliver(origin, "the wake")
            self.assertEqual(session["queued_prompt"]["text"], "user text")
            self.assertEqual([item["text"] for item in session["queued_prompts"]], ["later user text"])

            # No copy to withdraw: the queue already drained and the text is
            # running as a turn, which is a delivery.
            session["running"] = False
            fake_server.dispatch = lambda request, transport=None: {"result": {"status": "queued"}}
            self.assertEqual(wake.HermesDelivery().deliver(origin, "the wake"), "tui")
        self.assertFalse(session["history_lock"].locked())

    def test_unqueue_promotes_the_overflow_head_and_removes_one_copy_only(self):
        import wake

        session = {
            "queued_prompt": {"text": "the wake"},
            "queued_prompts": [{"text": "next"}, {"text": "the wake"}],
        }
        self.assertTrue(wake._tui_unqueue(session, "the wake"))
        self.assertEqual(session["queued_prompt"], {"text": "next"})
        self.assertEqual(session["queued_prompts"], [{"text": "the wake"}])
        self.assertFalse(wake._tui_unqueue({"queued_prompt": {"text": "something else"}}, "the wake"))
        self.assertFalse(wake._tui_unqueue({"queued_prompt": {"text": "the wake", "image_paths": ["a.png"]}}, "the wake"))

    def test_without_a_host_the_session_is_unreachable_and_never_claimed(self):
        import wake

        with mock.patch.dict(sys.modules, {"tui_gateway.server": None}):
            delivery = wake.HermesDelivery()
            origin = {"agent": "hermes", "session_id": "session-123", "session_key": "agent:main:slack:dm:x"}
            self.assertFalse(delivery.reachable(origin))
            with self.assertRaises(wake.SessionUnreachable):
                delivery.deliver(origin, "x")

    def test_cli_delivery_uses_inject_message_for_the_cli_session(self):
        import wake

        cli = types.SimpleNamespace(agent=types.SimpleNamespace(session_id="session-123"))
        manager = types.SimpleNamespace(_cli_ref=cli, has_gateway_message_injector=False)
        ctx = mock.Mock()
        ctx.inject_message.return_value = True
        ctx._manager = manager
        ctx._gateway_injection_allowed = lambda: False
        wake.set_context(ctx)
        fake_plugins = types.ModuleType("hermes_cli.plugins")
        fake_plugins.get_plugin_manager = lambda: manager
        with mock.patch.dict(sys.modules, {"tui_gateway.server": None, "hermes_cli.plugins": fake_plugins}):
            delivery = wake.HermesDelivery()
            self.assertTrue(delivery.reachable({"agent": "hermes", "session_id": "session-123"}))
            self.assertFalse(delivery.reachable({"agent": "hermes", "session_id": "session-other"}))
            self.assertEqual(delivery.deliver({"agent": "hermes", "session_id": "session-123"}, "hi"), "cli")
        ctx.inject_message.assert_called_once_with("hi")

    def test_gateway_delivery_needs_the_config_grant(self):
        import wake

        manager = types.SimpleNamespace(_cli_ref=None, has_gateway_message_injector=True)
        ctx = mock.Mock()
        ctx.inject_message.return_value = True
        ctx._manager = manager
        origin = {"agent": "hermes", "session_id": "session-123", "session_key": "agent:main:slack:dm:D1"}
        fake_plugins = types.ModuleType("hermes_cli.plugins")
        fake_plugins.get_plugin_manager = lambda: manager
        with mock.patch.dict(sys.modules, {"tui_gateway.server": None, "hermes_cli.plugins": fake_plugins}):
            ctx._gateway_injection_allowed = lambda: False
            wake.set_context(ctx)
            self.assertFalse(wake.HermesDelivery().reachable(origin))
            ctx._gateway_injection_allowed = lambda: True
            self.assertTrue(wake.HermesDelivery().reachable(origin))
            self.assertEqual(wake.HermesDelivery().deliver(origin, "hi"), "gateway")
        ctx.inject_message.assert_called_once_with("hi", session_key="agent:main:slack:dm:D1")

    # -- runtime contract -------------------------------------------------

    def test_plugin_contract_is_valid_for_hermes_runtime(self):
        executable = shutil.which("hermes")
        if not executable:
            self.skipTest("Hermes is not installed")
        result = subprocess.run(
            [executable, "plugins", "doctor", str(ROOT)],
            cwd=ROOT,
            env={**os.environ, "HERMES_HOME": str(self.state / "hermes-home")},
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("registrations: 4 tool(s)", result.stdout)


if __name__ == "__main__":
    unittest.main()
