"""Soak: many consecutive agentic messages in one chat must not degrade the server.

Reproduces the field report: "after ~5 messages the whole server slows down
and freezes; clients cannot connect, chats cannot be opened; it clears after
tens of minutes and freezes again as soon as you speak in that chat".

One client keeps chatting in a single conversation (streamed reasoning, tool
loops with large results, an image attachment, a branch graph, the
post-message indexing/tagging pipeline active) while a second client
repeatedly connects, lists chats and re-opens that conversation. The worst
navigation latency must stay bounded and must not grow message over message.

VULCAN_SOAK_MESSAGES / VULCAN_SOAK_CHATS scale it up; VULCAN_SOAK_REPORT=1
prints per-message latencies.
"""

import asyncio
import base64
import json
import os
import random
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_control_plane_e2e import SecureClient  # noqa: E402

from vulcan import agent_runtime as agent  # noqa: E402

MESSAGES = int(os.environ.get("VULCAN_SOAK_MESSAGES", "8"))
BACKGROUND_CHATS = int(os.environ.get("VULCAN_SOAK_CHATS", "40"))
REPORT = bool(os.environ.get("VULCAN_SOAK_REPORT"))
WORDS = ("docker network tailscale bread sourdough python async sqlite index vector cluster "
         "token stream branch transcript tool result reasoning answer").split()


def words(count: int, rng: random.Random) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(count))


class _StubEmbedder:
    def embed(self, texts):
        import numpy as np
        for text in texts:
            yield np.random.default_rng(abs(hash(text)) % 2**32).standard_normal(384).astype(np.float32)


class ChatSoakTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from vulcan import config as cfg
        cls._saved = (cfg.CONFIG_DIR, cfg.CHATS_DIR)
        cfg.CONFIG_DIR = Path(tempfile.mkdtemp(prefix="vulcan-soak-"))
        cfg.CHATS_DIR = cfg.CONFIG_DIR / "chats"

    @classmethod
    def tearDownClass(cls):
        from vulcan import config as cfg
        cfg.CONFIG_DIR, cfg.CHATS_DIR = cls._saved

    def _seed_corpus(self, rng):
        from vulcan import chats
        for index in range(BACKGROUND_CHATS):
            events = []
            for turn in range(20):
                events += [
                    {"id": f"bg{index}-u{turn}", "type": "user_message", "content": words(30, rng), "timestamp": "t"},
                    {"id": f"bg{index}-t{turn}", "type": "tool", "tool": "read_file", "arguments": {"path": "a"},
                     "result": {"result": {"content": words(2500, rng)}}, "status": "complete", "timestamp": "t"},
                    {"id": f"bg{index}-a{turn}", "type": "assistant_text", "content": words(250, rng),
                     "status": "complete", "timestamp": "t"},
                ]
            chats.save_chat({"schemaVersion": 2, "id": f"bg{index}", "title": f"Background {index}",
                             "createdAt": "c", "updatedAt": f"2026-01-{index % 28 + 1:02d}", "events": events})

    def test_consecutive_messages_do_not_freeze_navigation(self):
        from fastapi.testclient import TestClient
        from vulcan import recall, server, topics

        rng = random.Random(7)
        self._seed_corpus(rng)
        tool_rng = random.Random(11)

        async def provider(run, messages, tools, turn_id):
            # Agentic turn: reasoning, then 4 tool rounds, then a final answer.
            tool_turns = sum(1 for item in messages if item.get("role") == "tool") - provider.base_tools
            for index in range(120):
                run.stream_event({"type": "reasoning_delta", "delta": f"think{index} ", "wire": "reasoning"}, turn_id)
                if index % 10 == 0:
                    await asyncio.sleep(0.001)
            if tool_turns < 4:
                call = {"id": f"call-{turn_id}", "type": "function",
                        "function": {"name": "read_workspace_file", "arguments": json.dumps({"path": f"f{tool_turns}.txt"})}}
                run.stream_event({"type": "tool_call_delta", "index": 0, "id": call["id"],
                                  "nameDelta": call["function"]["name"], "argumentsDelta": call["function"]["arguments"]}, turn_id)
                return {"thinking": "", "content": "", "toolCalls": [call]}
            answer = []
            for index in range(400):
                token = f"answer{index} "
                answer.append(token)
                run.stream_event({"type": "text_delta", "delta": token}, turn_id)
                if index % 10 == 0:
                    await asyncio.sleep(0.001)
            return {"thinking": "", "content": "".join(answer), "toolCalls": [], "providerTerminal": True}
        provider.base_tools = 0

        async def tool(run, name, arguments, turn_id, event_id):
            await asyncio.sleep(0.01)
            return {"result": {"content": words(20000, tool_rng)}}  # ~150 KB tool output

        image = "data:image/png;base64," + base64.b64encode(os.urandom(300_000)).decode()
        chat = {"schemaVersion": 2, "id": "soak", "title": "New Chat", "createdAt": "c", "updatedAt": "u", "events": []}
        options = {"provider": {"baseUrl": "http://provider.test/v1", "model": "m", "networkPointOfView": "server"},
                   "settings": {"toolMode": "broad", "cliWorkspaceEnabled": False}}

        per_message = []
        stop_probe = threading.Event()
        samples: list[float] = []
        failures: list[str] = []

        def probe(test_client):
            # Second client: fresh connection + register + sidebar + open the busy chat.
            while not stop_probe.is_set():
                started = time.perf_counter()
                try:
                    other = SecureClient(test_client)
                    try:
                        other.request("client/register", {"client_id": "prober"}, timeout=60)
                        other.request("chats/list", {"summary_only": True}, timeout=60)
                        other.request("runs/subscribe", {"chat_id": "soak"}, timeout=60)
                    finally:
                        other.close()
                    samples.append(time.perf_counter() - started)
                except Exception as exc:  # timeout = frozen
                    failures.append(repr(exc))
                    samples.append(60.0)
                time.sleep(0.2)

        with mock.patch.object(agent, "_provider_response", provider), \
             mock.patch.object(agent, "execute_tool", tool), \
             mock.patch.object(recall, "embedder", lambda: _StubEmbedder()), \
             mock.patch.object(server.auth, "server_requires_auth", return_value=False):
            recall.start_message_indexing()
            test_client = TestClient(server.app)
            speaker = SecureClient(test_client)
            prober = threading.Thread(target=probe, args=(test_client,), daemon=True)
            prober.start()
            try:
                registered, _ = speaker.request("client/register", {"client_id": "speaker", "capabilities": ["run-delta-v1"]})
                capabilities = registered["payload"].get("capabilities") or []
                for message in range(MESSAGES):
                    user = {"id": f"soak-u{message}", "type": "user_message",
                            "content": f"message {message}: " + words(40, rng), "timestamp": "t"}
                    if message == 0:
                        user["attachments"] = [{"name": "shot.png", "type": "image/png", "size": 300_000, "dataUrl": image}]
                    chat["events"].append(user)
                    # The pre-overhaul renderer embedded every event in its branch graph.
                    chat["branching"] = {
                        "version": 1, "currentBranchId": "root",
                        "nodes": [{"event": event, "parentId": chat["events"][i - 1]["id"] if i else None}
                                  for i, event in enumerate(chat["events"])],
                        "branches": [{"id": "root", "parentBranchId": None, "origin": "root", "title": "Main",
                                      "titleSource": "auto", "createdAt": "c", "updatedAt": "u",
                                      "headEventId": chat["events"][-1]["id"]}],
                    }
                    provider.base_tools = sum(1 for event in chat["events"] if event.get("type") == "tool")
                    samples.clear()
                    started = time.perf_counter()
                    payload = {"chat": chat, "options": options, "capabilities": ["run-delta-v1"]}
                    if message and "runs-start-ref-v1" in capabilities:
                        # Current renderer: send only the new turn.
                        meta = {key: value for key, value in chat.items() if key != "events"}
                        payload = {**payload, "chat": {**meta, "events": []}, "chat_ref": {
                            "base_len": len(chat["events"]) - 1,
                            "base_last_id": chat["events"][-2]["id"],
                            "new_events": chat["events"][-1:],
                        }}
                    speaker.request("runs/start", payload, timeout=120)
                    while True:
                        status, _ = speaker.request("runs/status", {"chat_id": "soak"}, timeout=120)
                        if status["payload"]["status"] in ("idle", "complete"):
                            break
                        time.sleep(0.05)
                    run_seconds = time.perf_counter() - started
                    # Aftermath: indexing + tagging of the new messages.
                    time.sleep(1.5)
                    during = list(samples)
                    subscribed, _ = speaker.request("runs/subscribe", {"chat_id": "soak"}, timeout=120)
                    chat = subscribed["payload"]["chat"]
                    worst = max(during) if during else 0.0
                    per_message.append((run_seconds, worst, len(during)))
                    if REPORT:
                        lag = ""
                        try:
                            metrics, _ = speaker.request("server/metrics", {}, timeout=10)
                            lag = f", loop lag peak so far {metrics['payload']['loop_lag']['peak_ms']:.0f}ms"
                        except Exception:
                            pass  # pre-overhaul servers have no metrics RPC
                        print(f"message {message + 1}: run {run_seconds:.2f}s, worst second-client "
                              f"connect+list+open {worst * 1000:.0f}ms over {len(during)} probes, "
                              f"events {len(chat['events'])}{lag}", flush=True)
            finally:
                stop_probe.set()
                prober.join(timeout=120)
                speaker.close()

        self.assertEqual(failures, [], failures[:3])
        worst_overall = max(worst for _run, worst, _count in per_message)
        self.assertLess(worst_overall, 5.0, f"navigation stalled for {worst_overall:.1f}s")
        # No message-over-message degradation: late messages are not much worse than early ones.
        early = max(per_message[1][0], 0.5)
        late = per_message[-1][0]
        self.assertLess(late, early * 3, f"run time degraded from {early:.2f}s to {late:.2f}s")
        self.assertTrue(all(count > 0 for _run, _worst, count in per_message), "prober starved")


if __name__ == "__main__":
    unittest.main()
