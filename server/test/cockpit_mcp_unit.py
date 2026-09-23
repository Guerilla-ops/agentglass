#!/usr/bin/env python3
"""Unit tests for agentglass-cockpit-mcp (stdlib only; no Bun server)."""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import threading
import types
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = pathlib.Path(__file__).resolve().parents[2]
BIN = ROOT / "bin" / "agentglass-cockpit-mcp"


def load_mcp():
    src = BIN.read_text(encoding="utf-8")
    mod = types.ModuleType("cockpit_mcp")
    mod.__file__ = str(BIN)
    exec(compile(src, str(BIN), "exec"), mod.__dict__)
    return mod


class BoundedJsonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load_mcp()

    def test_under_ceiling_untouched(self):
        out = self.m.bounded_json(
            {"ok": True, "cost_usd": 1.25, "tokens": {"input": 3}, "truncated": False, "omitted": []},
            max_bytes=2048,
        )
        self.assertFalse(out["truncated"])
        self.assertEqual(out["omitted"], [])
        self.assertEqual(out["cost_usd"], 1.25)

    def test_over_ceiling_drops_optional_and_names_them(self):
        fat = {
            "ok": True,
            "session_id": "s1",
            "cost_usd": 9.99,
            "tokens": {"input": 1, "output": 2},
            "summary": "x" * 5000,
            "tool_mix": [{"tool": "Bash", "n": 99}] * 200,
            "subagents": [{"agent_id": f"a{i}", "agent_type": "explore", "events": i} for i in range(200)],
            "truncated": False,
            "omitted": [],
        }
        out = self.m.bounded_json(fat, max_bytes=800)
        self.assertTrue(out["truncated"])
        self.assertTrue(any(k in out["omitted"] for k in ("summary", "tool_mix", "subagents")))
        self.assertEqual(out["cost_usd"], 9.99)
        self.assertLessEqual(len(json.dumps(out, separators=(",", ":")).encode()), 800)

    def test_never_mid_string_truncates_json(self):
        out = self.m.bounded_json(
            {"ok": True, "session_id": "s", "cost_usd": 1, "summary": "hello world " * 2000},
            max_bytes=400,
        )
        self.assertIn("ok", out)
        json.dumps(out)


def _session_payload(sid="sess-1"):
    return {
        "session_id": sid,
        "source_app": "claude-code",
        "model_name": "claude-opus",
        "custom_title": "Ship cockpit MCP",
        "project_path": "/tmp/demo",
        "cwd_path": "/tmp/demo",
        "events": 12,
        "tools": 4,
        "errors": 1,
        "cost_usd": 1.23,
        "input_tokens": 100,
        "output_tokens": 50,
        "cache_creation_tokens": 10,
        "cache_read_tokens": 20,
        "equiv_tokens": 130,
        "summary": "working",
        "tool_mix": [{"tool": "Bash", "n": 3}],
        "subagents": [],
    }


class SessionSpendHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load_mcp()
        cls.hits: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.hits.append(self.path)
                u = urlparse(self.path)
                if u.path == "/session":
                    sid = (parse_qs(u.query).get("id") or [""])[0]
                    if sid != "sess-1":
                        body, code = {"error": "not found"}, 404
                    else:
                        body, code = _session_payload(), 200
                    raw = json.dumps(body).encode()
                    self.send_response(code)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                self.send_response(404)
                self.end_headers()

            def log_message(self, *args):
                return

        cls.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.m.SERVER = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_spend_happy_path(self):
        self.hits.clear()
        out = self.m.session_spend({"session_id": "sess-1"})
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["cost_usd"], 1.23)
        self.assertEqual(out["tokens"]["input"], 100)
        self.assertEqual(out["tokens"]["cache_read"], 20)
        self.assertEqual(out["title"], "Ship cockpit MCP")
        self.assertFalse(out["truncated"])
        self.assertTrue(any(h.startswith("/session?") for h in self.hits))

    def test_spend_missing_session(self):
        # The id falls back to the environment, and a suite run from inside an
        # agent session has one: without clearing it this asked for that
        # session instead of reporting the missing argument.
        ids = ("AGENTGLASS_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID")
        with mock.patch.dict(os.environ, {k: "" for k in ids}):
            out = self.m.session_spend({})
        self.assertFalse(out["ok"])
        self.assertIn("session_id", out["error"])

    def test_spend_unknown_session(self):
        out = self.m.session_spend({"session_id": "nope"})
        self.assertFalse(out["ok"])


class McpStdioTests(unittest.TestCase):
    def test_initialize_list_and_call_against_mock(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                raw = json.dumps(_session_payload()).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                return

        httpd = HTTPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            env = {**os.environ, "AGENTGLASS_SERVER": f"http://127.0.0.1:{port}"}
            # stderr=DEVNULL avoids the classic pipe deadlock where a child
            # blocked on a full stderr buffer leaves the parent stuck on stdout.
            p = subprocess.Popen(
                [sys.executable, "-u", str(BIN)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=env,
                text=True,
                bufsize=1,
            )
            assert p.stdin and p.stdout

            def rpc(obj):
                p.stdin.write(json.dumps(obj) + "\n")
                p.stdin.flush()
                line = p.stdout.readline()
                self.assertTrue(line, msg="no MCP line on stdout")
                return json.loads(line)

            init = rpc(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "test", "version": "0"},
                    },
                }
            )
            self.assertEqual(init["result"]["serverInfo"]["name"], "agentglass-cockpit")
            tools = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
            self.assertEqual([t["name"] for t in tools["result"]["tools"]], ["cockpit_session_spend"])
            called = rpc(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "cockpit_session_spend",
                        "arguments": {"session_id": "sess-1"},
                    },
                }
            )
            payload = json.loads(called["result"]["content"][0]["text"])
            self.assertTrue(payload["ok"], payload)
            self.assertEqual(payload["cost_usd"], 1.23)
            p.stdin.close()
            p.stdout.close()
            self.assertEqual(p.wait(timeout=5), 0)
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
