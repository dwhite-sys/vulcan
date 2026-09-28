"""End-to-end control-plane responsiveness through the real encrypted /ws/general.

Acceptance (traffic handoff, Pass B): while one client's run produces model
output as fast as the loop allows, a *second* client can connect and
register, and the first client's status and Stop remain responsive. The
live transcript the first client receives must still reconstruct exactly.
"""

import asyncio
import base64
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import x25519  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

from vulcan import agent_runtime as agent  # noqa: E402
from vulcan import secure_ws  # noqa: E402


class SecureClient:
    """Minimal Python mirror of the renderer's SecureWebSocket + GeneralWSClient."""

    def __init__(self, test_client):
        self._context = test_client.websocket_connect("/ws/general")
        self.ws = self._context.__enter__()
        hello = json.loads(self.ws.receive_text())
        private = x25519.X25519PrivateKey.generate()
        public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        prefix = os.urandom(4)
        self.ws.send_text(json.dumps({
            "type": "handshake/client", "version": 1,
            "ephemeral": base64.b64encode(public).decode(), "send_prefix": base64.b64encode(prefix).decode(),
        }))
        server_ephemeral = base64.b64decode(hello["ephemeral"])
        server_prefix = base64.b64decode(hello["send_prefix"])
        shared = private.exchange(x25519.X25519PublicKey.from_public_bytes(server_ephemeral))
        transcript = (secure_ws._CONTEXT + base64.b64decode(hello["identity"]) + server_ephemeral
                      + public + server_prefix + prefix)
        c2s, s2c = secure_ws._derive_keys(shared, transcript)
        self._send_cipher, self._receive_cipher = AESGCM(c2s), AESGCM(s2c)
        self._send_prefix, self._receive_prefix = prefix, server_prefix
        self._send_sequence = self._receive_sequence = 0
        assert json.loads(self.ws.receive_text())["type"] == "handshake/ready"
        self._send_lock = threading.Lock()
        self.pushes: list[dict] = []
        self._responses: dict[str, dict] = {}
        self._waiters: dict[str, threading.Event] = {}
        self._closed = False
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self):
        while not self._closed:
            try:
                raw = self.ws.receive_text()
            except Exception:
                return
            envelope = json.loads(raw)
            sequence = envelope["sequence"]
            assert sequence == self._receive_sequence
            plaintext = self._receive_cipher.decrypt(
                secure_ws._nonce(self._receive_prefix, sequence),
                base64.b64decode(envelope["ciphertext"]), secure_ws._aad(sequence))
            self._receive_sequence += 1
            message = json.loads(plaintext)
            if message.get("id"):
                self._responses[message["id"]] = message
                waiter = self._waiters.get(message["id"])
                if waiter:
                    waiter.set()
            else:
                self.pushes.append(message)

    def request(self, msg_type: str, payload: dict, timeout: float = 10.0) -> tuple[dict, float]:
        request_id = uuid.uuid4().hex
        waiter = self._waiters[request_id] = threading.Event()
        started = time.perf_counter()
        with self._send_lock:
            sequence = self._send_sequence
            plaintext = json.dumps({"id": request_id, "type": msg_type, "payload": payload}).encode()
            ciphertext = self._send_cipher.encrypt(
                secure_ws._nonce(self._send_prefix, sequence), plaintext, secure_ws._aad(sequence))
            self.ws.send_text(json.dumps({"type": "secure", "sequence": sequence,
                                          "ciphertext": base64.b64encode(ciphertext).decode()}))
            self._send_sequence += 1
        if not waiter.wait(timeout):
            raise TimeoutError(f"{msg_type} timed out")
        return self._responses.pop(request_id), time.perf_counter() - started

    def close(self):
        self._closed = True
        try:
            self._context.__exit__(None, None, None)
        except Exception:
            pass


def mirror_transcript(pushes: list[dict]) -> dict[str, dict]:
    events: dict[str, dict] = {}
    seqs: dict[str, int] = {}
    for message in pushes:
        kind, payload = message["type"], message.get("payload") or {}
        if kind == "push/run-event":
            event, seq = payload["event"], int(payload.get("seq", 0))
            if seq >= seqs.get(event["id"], -1):
                events[event["id"]], seqs[event["id"]] = dict(event), seq
        elif kind == "push/run-events":
            for event in payload["events"]:
                events[event["id"]] = dict(event)
            seqs.update(payload.get("seqs") or {})
        elif kind == "push/run-delta":
            known = seqs.get(payload["event_id"])
            if known is not None and int(payload["seq"]) == known + 1:
                event = events[payload["event_id"]]
                for name, text in (payload.get("append") or {}).items():
                    event[name] = (event.get(name) or "") + text
                seqs[payload["event_id"]] = int(payload["seq"])
    return events


class ControlPlaneUnderLoadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from vulcan import config as cfg
        cls._saved = (cfg.CONFIG_DIR, cfg.CHATS_DIR)
        cfg.CONFIG_DIR = Path(tempfile.mkdtemp(prefix="vulcan-e2e-"))
        cfg.CHATS_DIR = cfg.CONFIG_DIR / "chats"

    @classmethod
    def tearDownClass(cls):
        from vulcan import config as cfg
        cfg.CONFIG_DIR, cfg.CHATS_DIR = cls._saved

    def test_second_client_register_status_and_stop_stay_responsive_during_heavy_generation(self):
        from fastapi.testclient import TestClient
        from vulcan import server

        produced = {"tokens": 0}
        release_final = threading.Event()

        async def flood_provider(run, messages, tools, turn_id):
            # A provider producing output as fast as the loop allows, for
            # as long as the test needs (until Stop cancels it).
            index = 0
            while True:
                run.stream_event({"type": "text_delta", "delta": f"token-{index} "}, turn_id)
                index += 1
                produced["tokens"] = index
                if index % 25 == 0:
                    await asyncio.sleep(0)

        chat = {
            "schemaVersion": 2, "id": "e2e-flood", "title": "New Chat",
            "createdAt": "2026-09-27T00:00:00Z", "updatedAt": "2026-09-27T00:00:00Z",
            "events": [{"id": "e2e-user", "type": "user_message", "content": "flood",
                        "timestamp": "2026-09-27T00:00:00Z"}],
        }
        options = {"provider": {"baseUrl": "http://provider.test/v1", "model": "m", "networkPointOfView": "server"},
                   "settings": {"toolMode": "search", "cliWorkspaceEnabled": False}}

        with mock.patch.object(agent, "_provider_response", flood_provider), \
             mock.patch.object(server.auth, "server_requires_auth", return_value=False):
            test_client = TestClient(server.app)
            first = SecureClient(test_client)
            try:
                registered, _ = first.request("client/register", {"client_id": "device-a", "capabilities": ["run-delta-v1"]})
                self.assertIn("run-delta-v1", registered["payload"]["capabilities"])
                started, _ = first.request("runs/start", {"chat": chat, "options": options, "capabilities": ["run-delta-v1"]})
                self.assertEqual(started["payload"]["status"], "running")
                time.sleep(0.5)
                self.assertGreater(produced["tokens"], 1000, "the flood provider should be producing heavily")

                second = SecureClient(test_client)
                try:
                    _, register_latency = second.request("client/register", {"client_id": "device-b"})
                    _, ping_latency = second.request("ping", {})
                finally:
                    second.close()
                _, status_latency = first.request("runs/status", {"chat_id": "e2e-flood"})
                tokens_before_stop = produced["tokens"]
                stopped, stop_latency = first.request("runs/cancel", {"chat_id": "e2e-flood"})
                self.assertTrue(stopped["payload"]["ok"])
                time.sleep(0.3)
            finally:
                first.close()

        if os.environ.get("VULCAN_E2E_REPORT"):
            print(f"\nE2E tokens={tokens_before_stop} register={register_latency*1000:.1f}ms ping={ping_latency*1000:.1f}ms "
                  f"status={status_latency*1000:.1f}ms stop={stop_latency*1000:.1f}ms")
        # Generous CI bounds: before the overhaul these could stall for many
        # seconds behind the generation; now they must stay interactive.
        self.assertLess(register_latency, 1.0, f"second client register took {register_latency:.3f}s")
        self.assertLess(ping_latency, 1.0)
        self.assertLess(status_latency, 1.0, f"runs/status took {status_latency:.3f}s")
        self.assertLess(stop_latency, 3.0, f"Stop took {stop_latency:.3f}s")
        self.assertGreater(tokens_before_stop, 2000)

        # The live stream the first client saw reconstructs the durable text.
        from vulcan import chats
        stored = chats.load_chat("e2e-flood")
        text = next(event for event in stored["events"] if event["type"] == "assistant_text")
        self.assertEqual(text["status"], "interrupted")
        mirrored = mirror_transcript(first.pushes)
        self.assertEqual(mirrored[text["id"]]["content"], text["content"])
        self.assertTrue(any(message["type"] == "push/run-delta" for message in first.pushes))
        release_final.set()


if __name__ == "__main__":
    unittest.main()
