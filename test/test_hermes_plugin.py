import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class FakeQueueHandler(BaseHTTPRequestHandler):
    asks = {}
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
        if self.path.endswith("/collect"):
            ticket = self.path.split("/")[3]
            ask = self.asks[ticket]
            ask["status"] = "collected"
            return self._json(200, {"ask": ask})
        return self._json(404, {"error": "not found"})


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
                "HERMES_SESSION_SOURCE": "tui",
            },
            clear=False,
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_file_uses_dynamic_hermes_origin_and_returns_native_url(self):
        import hermes

        result = hermes.unblock_file(
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

        self.assertEqual(result["ticket"], "ub_testticket")
        self.assertIn("/u/link-token", result["url"])
        create = next(call for call in FakeQueueHandler.calls if call[1] == "/api/asks")
        self.assertEqual(create[2]["origin"]["agent"], "hermes")
        self.assertEqual(create[2]["origin"]["session_id"], "session-123")
        self.assertNotIn("pane_id", create[2]["origin"])
        self.assertEqual(create[3], "Bearer test-auth")

    def test_check_collects_answers_for_the_current_session(self):
        import hermes

        FakeQueueHandler.asks["ub_done"] = {
            "ticket": "ub_done",
            "kind": "file",
            "purpose": "decision",
            "title": "Done",
            "why": "why",
            "fields": [{"name": "answer", "type": "text", "label": "Answer"}],
            "answers": {"answer": "Use buyer calls"},
            "field_context": {},
            "origin": {"agent": "hermes", "session_id": "session-123"},
            "status": "answered",
            "created_at": 1,
        }

        result = hermes.unblock_check({})

        self.assertEqual([ask["ticket"] for ask in result["asks"]], ["ub_done"])
        pending_call = next(call for call in FakeQueueHandler.calls if call[1].startswith("/api/pending?"))
        self.assertIn("agent=hermes", pending_call[1])
        self.assertIn("session_id=session-123", pending_call[1])
        self.assertTrue(any(call[1] == "/api/asks/ub_done/collect" for call in FakeQueueHandler.calls))

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
