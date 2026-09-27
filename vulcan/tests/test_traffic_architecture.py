"""Traffic/concurrency architecture regressions.

Covers the semantic hot path (buffered accumulation, ordered run deltas),
egress lanes (control never waits behind bulk, ordering barrier, bounded
stream degradation), ingress admission, and client relay flow control.
"""

import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

TEST_DIR = Path(tempfile.mkdtemp(prefix="vulcan-traffic-"))
os.environ["HOME"] = str(TEST_DIR)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from vulcan import agent_runtime as agent  # noqa: E402
from vulcan import etna_registry, traffic, ws_general  # noqa: E402


def decode(plaintext: bytes) -> dict:
    return json.loads(plaintext)


class RecordingTransport:
    """Secure-transport stand-in recording plaintext frames, optionally slow."""

    def __init__(self, bytes_per_second: float | None = None):
        self.frames: list[dict] = []
        self.bytes_per_second = bytes_per_second
        self.gate: asyncio.Event | None = None

    async def send_plaintext(self, plaintext: bytes) -> None:
        if self.gate is not None:
            await self.gate.wait()
        if self.bytes_per_second:
            await asyncio.sleep(len(plaintext) / self.bytes_per_second)
        self.frames.append(decode(plaintext))


class TranscriptMirror:
    """Python mirror of the renderer's delta/snapshot application rule."""

    def __init__(self):
        self.events: dict[str, dict] = {}
        self.order: list[str] = []
        self.seq: dict[str, int] = {}
        self.gaps = 0
        self.stale = 0

    def apply(self, message: dict) -> None:
        kind, payload = message.get("type"), message.get("payload") or {}
        if kind == "push/run-event":
            event, seq = payload["event"], int(payload.get("seq", 0))
            if seq < self.seq.get(event["id"], -1):
                self.stale += 1
                return
            if event["id"] not in self.events:
                self.order.append(event["id"])
            self.events[event["id"]] = json.loads(json.dumps(event))
            self.seq[event["id"]] = seq
        elif kind == "push/run-events":
            for event in payload["events"]:
                if event["id"] not in self.events:
                    self.order.append(event["id"])
                self.events[event["id"]] = json.loads(json.dumps(event))
            self.seq.update(payload.get("seqs") or {})
        elif kind == "push/run-delta":
            event_id, seq = payload["event_id"], int(payload["seq"])
            known = self.seq.get(event_id)
            if known is None or seq > known + 1:
                self.gaps += 1
                return
            if seq <= known:
                return
            event = self.events[event_id]
            for name, text in (payload.get("append") or {}).items():
                event[name] = (event.get(name) or "") + text
            for name, items in (payload.get("extend") or {}).items():
                event[name] = [*(event.get(name) or []), *items]
            event.update(payload.get("set") or {})
            self.seq[event_id] = seq


def base_chat(chat_id: str) -> dict:
    return {
        "schemaVersion": 2, "id": chat_id, "title": "New Chat",
        "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
        "events": [{"id": f"{chat_id}-user", "type": "user_message", "content": "go",
                    "timestamp": "2026-09-01T00:00:00Z"}],
    }


class ProviderParserTests(unittest.TestCase):
    def test_parser_accumulates_chunks_without_growing_strings(self):
        emitted = []
        parser = agent.ProviderStreamParser(emitted.append)
        for index in range(5000):
            parser.process_delta({"content": f"t{index} "})
            parser.process_delta({"reasoning_content": "r"})
        parser.process_delta({"tool_calls": [{"index": 0, "id": "c", "function": {"name": "write_", "arguments": '{"a":'}}]})
        parser.process_delta({"tool_calls": [{"index": 0, "function": {"name": "file", "arguments": '"x"}'}}]})
        result = parser.finish()
        self.assertEqual(result["content"], "".join(f"t{index} " for index in range(5000)))
        self.assertEqual(result["thinking"], "r" * 5000)
        self.assertEqual(result["toolCalls"][0]["function"], {"name": "write_file", "arguments": '{"a":"x"}'})
        # No aggregate string attributes are maintained during streaming.
        self.assertFalse(isinstance(parser.__dict__.get("content"), str))


class RunDeltaProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def _run_stream(self, *, deltas: bool, tokens: int = 3000):
        transport = RecordingTransport()
        session = ws_general.GeneralWSSession(transport)
        session.supports_run_deltas = deltas
        manager = agent.RunManager()
        chat = base_chat(f"delta-{deltas}-{tokens}")
        run = agent.AgentRun(chat=chat, options={}, manager=manager, run_id="run")
        manager.subscribe(chat["id"], session)
        for index in range(tokens):
            run.stream_event({"type": "reasoning_delta" if index < 10 else "text_delta",
                              "delta": f"w{index} "}, "turn")
            if index % 50 == 0:
                await asyncio.sleep(0)
        run.stream_event({"type": "tool_call_delta", "index": 0, "id": "call-1",
                          "nameDelta": "vis", "argumentsDelta": '{"a"'}, "turn")
        run.stream_event({"type": "tool_call_delta", "index": 0,
                          "nameDelta": "ualize", "argumentsDelta": ':1}'}, "turn")
        await asyncio.sleep(0.1)
        run.finalize_streams()
        run._publish()
        for _ in range(50):
            await asyncio.sleep(0.01)
        session.cleanup()
        return run, transport.frames

    async def test_live_tokens_travel_as_ordered_deltas_not_growing_snapshots(self):
        run, frames = await self._run_stream(deltas=True)
        mirror = TranscriptMirror()
        for frame in frames:
            mirror.apply(frame)
        kinds = [frame["type"] for frame in frames]
        deltas = [frame for frame in frames if frame["type"] == "push/run-delta"]
        self.assertTrue(deltas)
        # Far fewer frames than tokens (40ms coalescing) and no per-token snapshots.
        self.assertLess(kinds.count("push/run-event"), 10)
        self.assertLess(len(deltas), 3000)
        # Deltas carry only new text: the total bytes sent for the body equal
        # the body itself (no growing re-transmission of earlier content).
        text = next(event for event in run.events if event["type"] == "assistant_text")
        sent = sum(len(item["payload"].get("append", {}).get("content", ""))
                   for item in deltas if item["payload"]["event_id"] == text["id"])
        self.assertEqual(sent, len(text["content"]))
        self.assertEqual(mirror.gaps, 0)
        for event in run.events[1:]:
            mirrored = mirror.events[event["id"]]
            for name in ("content", "tool", "rawArguments", "callId"):
                if name in event:
                    self.assertEqual(mirrored.get(name), event[name], name)

    async def test_delta_only_mirror_reconstructs_before_final_snapshot(self):
        run, frames = await self._run_stream(deltas=True, tokens=500)
        mirror = TranscriptMirror()
        for frame in frames:
            if frame["type"] == "push/run-events":
                break
            mirror.apply(frame)
        text = next(event for event in run.events if event["type"] == "assistant_text")
        self.assertEqual(mirror.events[text["id"]]["content"], text["content"])
        self.assertEqual(mirror.gaps, 0)

    async def test_legacy_subscriber_gets_coalesced_snapshots_only(self):
        run, frames = await self._run_stream(deltas=False)
        self.assertFalse(any(frame["type"] == "push/run-delta" for frame in frames))
        mirror = TranscriptMirror()
        for frame in frames:
            mirror.apply(frame)
        text = next(event for event in run.events if event["type"] == "assistant_text")
        self.assertEqual(mirror.events[text["id"]]["content"], text["content"])

    async def test_background_chats_get_boundaries_but_no_token_traffic(self):
        transport = RecordingTransport()
        session = ws_general.GeneralWSSession(transport)
        session.supports_run_deltas = True
        manager = agent.RunManager()
        foreground = agent.AgentRun(chat=base_chat("fg"), options={}, manager=manager, run_id="fg-run")
        background = agent.AgentRun(chat=base_chat("bg"), options={}, manager=manager, run_id="bg-run")
        manager.subscribe("fg", session)
        manager.subscribe("bg", session)
        session.focused_chat_id = "fg"
        for index in range(200):
            foreground.stream_event({"type": "text_delta", "delta": f"f{index} "}, "turn")
            background.stream_event({"type": "text_delta", "delta": f"b{index} "}, "turn")
            await asyncio.sleep(0.001)
        foreground.seal_semantic()
        background.seal_semantic()
        await asyncio.sleep(0.05)
        deltas = [frame for frame in transport.frames if frame["type"] == "push/run-delta"]
        self.assertTrue(deltas)
        self.assertTrue(all(frame["payload"]["chat_id"] == "fg" for frame in deltas))
        sealed = [frame for frame in transport.frames
                  if frame["type"] == "push/run-event" and frame["payload"]["chat_id"] == "bg"
                  and frame["payload"]["event"].get("status") == "complete"]
        self.assertEqual(sealed[-1]["payload"]["event"]["content"], background.events[-1]["content"])
        session.cleanup()

    async def test_end_of_run_snapshot_is_the_run_tail_for_delta_clients(self):
        modern, legacy = RecordingTransport(), RecordingTransport()
        modern_session = ws_general.GeneralWSSession(modern)
        modern_session.supports_run_deltas = True
        legacy_session = ws_general.GeneralWSSession(legacy)
        manager = agent.RunManager()
        chat = base_chat("tail")
        chat["events"] = [{"id": f"old{index}", "type": "assistant_text", "content": "history " * 100,
                           "timestamp": "t"} for index in range(50)] + chat["events"]
        run = agent.AgentRun(chat=chat, options={}, manager=manager, run_id="run")
        run.persist_base = len(chat["events"])
        manager.subscribe("tail", modern_session)
        manager.subscribe("tail", legacy_session)
        run.stream_event({"type": "text_delta", "delta": "new answer"}, "turn")
        run.finalize_streams()
        run._publish()
        await asyncio.sleep(0.05)
        tail = next(frame for frame in modern.frames if frame["type"] == "push/run-events")["payload"]
        full = next(frame for frame in legacy.frames if frame["type"] == "push/run-events")["payload"]
        self.assertEqual(tail["tail_from"], 51)
        self.assertEqual(tail["base_last_id"], "tail-user")
        self.assertEqual([event["id"] for event in tail["events"]], [run.events[-1]["id"]])
        self.assertEqual(len(full["events"]), 52)
        modern_session.cleanup()
        legacy_session.cleanup()

    async def test_quiet_provider_does_not_strand_received_tokens(self):
        transport = RecordingTransport()
        session = ws_general.GeneralWSSession(transport)
        session.supports_run_deltas = True
        manager = agent.RunManager()
        chat = base_chat("quiet")
        run = agent.AgentRun(chat=chat, options={}, manager=manager, run_id="run")
        manager.subscribe(chat["id"], session)
        run.stream_event({"type": "text_delta", "delta": "first"}, "turn")
        run.stream_event({"type": "text_delta", "delta": " second"}, "turn")
        # No further tokens: the flush timer must still publish " second".
        await asyncio.sleep(0.15)
        mirror = TranscriptMirror()
        for frame in transport.frames:
            mirror.apply(frame)
        self.assertEqual(mirror.events[run.events[-1]["id"]]["content"], "first second")
        session.cleanup()

    async def test_active_subscribe_response_equals_direct_snapshot_and_orders_deltas(self):
        transport = RecordingTransport()
        session = ws_general.GeneralWSSession(transport)
        session.supports_run_deltas = True
        chat = base_chat("sub-splice")
        chat["events"] = [{"id": f"h{index}", "type": "assistant_text", "content": "history " * 50,
                           "timestamp": "t"} for index in range(30)] + chat["events"]
        chat["branching"] = {"version": 1, "currentBranchId": "root", "nodes": [], "branches": []}
        run = agent.AgentRun(chat=chat, options={}, manager=agent.MANAGER, run_id="run")
        run.persist_base = len(chat["events"])
        run.task = asyncio.get_running_loop().create_future()  # looks active
        agent.MANAGER.runs["sub-splice"] = run
        try:
            run.stream_event({"type": "text_delta", "delta": "before "}, "turn")
            run.flush_deltas()
            await session.handle_message({"id": "s", "type": "runs/subscribe", "payload": {"chat_id": "sub-splice"}})
            run.stream_event({"type": "text_delta", "delta": "after"}, "turn")
            run.flush_deltas()
            await asyncio.sleep(0.05)
            response = next(frame for frame in transport.frames if frame.get("id") == "s")["payload"]
            expected = json.loads(json.dumps(run.subscription_snapshot()["chat"]))
            expected["events"][-1]["content"] = "before "
            self.assertEqual(response["chat"], expected)
            mirror = TranscriptMirror()
            mirror.apply({"type": "push/run-events", "payload": {"events": response["chat"]["events"], "seqs": response["seqs"]}})
            after = transport.frames[transport.frames.index(next(f for f in transport.frames if f.get("id") == "s")) + 1:]
            for frame in after:
                mirror.apply(frame)
            self.assertEqual(mirror.gaps, 0)
            self.assertEqual(mirror.events[run.events[-1]["id"]]["content"], "before after")
        finally:
            agent.MANAGER.runs.pop("sub-splice", None)
            agent.MANAGER.unsubscribe(session)
            session.cleanup()

    async def test_subscription_snapshot_is_consistent_with_seq(self):
        manager = agent.RunManager()
        chat = base_chat("snapshot-seq")
        run = agent.AgentRun(chat=chat, options={}, manager=manager, run_id="run")
        for index in range(20):
            run.stream_event({"type": "text_delta", "delta": f"{index},"}, "turn")
            run.flush_deltas()
        run.stream_event({"type": "text_delta", "delta": "pending"}, "turn")
        snapshot = json.loads(json.dumps(run.subscription_snapshot()))
        event = snapshot["chat"]["events"][-1]
        self.assertEqual(event["content"], "".join(f"{index}," for index in range(20)) + "pending")
        self.assertEqual(snapshot["seqs"][event["id"]], run.stream_seq[event["id"]])


class EgressLaneTests(unittest.IsolatedAsyncioTestCase):
    async def test_control_is_not_queued_behind_bulk_backlog(self):
        transport = RecordingTransport(bytes_per_second=40 * 1024 * 1024)
        scheduler = traffic.EgressScheduler(transport.send_plaintext, agent.encode_message)
        bulk = [asyncio.create_task(scheduler.send(agent.encode_message({"id": f"b{i}", "type": "chats/get/response",
                                                                          "payload": "x" * 1_000_000}), traffic.BULK))
                for i in range(8)]
        await asyncio.sleep(0.005)
        started = time.perf_counter()
        await scheduler.send(agent.encode_message({"id": "reg", "type": "client/register/response", "payload": {}}), traffic.CONTROL)
        control_latency = time.perf_counter() - started
        ids = [frame.get("id") for frame in transport.frames]
        # At most the bulk frame(s) already on the wire precede control.
        self.assertLessEqual(ids.index("reg"), 2)
        self.assertLess(control_latency, 0.1)
        await asyncio.gather(*bulk)
        scheduler.close()

    async def test_bulk_producers_are_backpressured_by_bytes(self):
        transport = RecordingTransport()
        transport.gate = asyncio.Event()
        budgets = traffic.EgressBudgets(bulk_soft=1_000_000)
        scheduler = traffic.EgressScheduler(transport.send_plaintext, agent.encode_message, budgets=budgets)
        senders = [asyncio.create_task(scheduler.send(b"x" * 300_000, traffic.BULK)) for _ in range(20)]
        await asyncio.sleep(0.02)
        self.assertLessEqual(scheduler.queued_bytes(traffic.BULK), 1_000_000)
        transport.gate.set()
        await asyncio.gather(*senders, return_exceptions=True)
        scheduler.close()

    async def test_stream_delta_never_overtakes_earlier_authoritative_state(self):
        transport = RecordingTransport(bytes_per_second=10 * 1024 * 1024)
        scheduler = traffic.EgressScheduler(transport.send_plaintext, agent.encode_message)
        # Lots of STATE ahead, then a delta; DRR would otherwise let STREAM in.
        for index in range(20):
            scheduler.post(agent.encode_message({"type": "push/run-event", "payload": {"n": index, "pad": "p" * 20000}}), traffic.STATE)
        scheduler.post_stream("k", agent.encode_message({"type": "push/run-delta", "payload": {"n": "delta"}}), lambda: None)
        for index in range(20, 40):
            scheduler.post(agent.encode_message({"type": "push/run-event", "payload": {"n": index, "pad": "p" * 20000}}), traffic.STATE)
        for _ in range(200):
            await asyncio.sleep(0.005)
            if len(transport.frames) == 41:
                break
        order = [frame["payload"]["n"] for frame in transport.frames]
        delta_at = order.index("delta")
        self.assertTrue(set(range(20)).issubset(order[:delta_at]))
        scheduler.close()

    async def test_ordered_subscribe_response_precedes_later_deltas(self):
        transport = RecordingTransport(bytes_per_second=20 * 1024 * 1024)
        scheduler = traffic.EgressScheduler(transport.send_plaintext, agent.encode_message)
        response = asyncio.create_task(scheduler.send(
            agent.encode_message({"id": "sub", "type": "runs/subscribe/response", "payload": "x" * 500_000}),
            traffic.BULK, ordered=True))
        await asyncio.sleep(0)
        scheduler.post_stream("k", agent.encode_message({"type": "push/run-delta", "payload": {"seq": 1}}), lambda: None)
        await response
        await asyncio.sleep(0.02)
        self.assertEqual([frame.get("id") or frame["type"] for frame in transport.frames], ["sub", "push/run-delta"])
        scheduler.close()

    async def test_ordered_frame_waiting_for_capacity_still_precedes_later_deltas(self):
        transport = RecordingTransport()
        transport.gate = asyncio.Event()
        budgets = traffic.EgressBudgets(bulk_soft=100_000)
        scheduler = traffic.EgressScheduler(transport.send_plaintext, agent.encode_message, budgets=budgets)
        filler = asyncio.create_task(scheduler.send(agent.encode_message({"id": "fill", "type": "x", "payload": "f" * 90_000}), traffic.BULK))
        await asyncio.sleep(0)
        # The subscribe snapshot must wait for BULK capacity...
        response = asyncio.create_task(scheduler.send(
            agent.encode_message({"id": "sub", "type": "runs/subscribe/response", "payload": "s" * 50_000}),
            traffic.BULK, ordered=True))
        await asyncio.sleep(0)
        # ...while a newer delta is produced; it must not overtake the snapshot.
        scheduler.post_stream("k", agent.encode_message({"type": "push/run-delta", "payload": {"seq": 9}}), lambda: None)
        transport.gate.set()
        await asyncio.gather(filler, response)
        await asyncio.sleep(0.02)
        order = [frame.get("id") or frame["type"] for frame in transport.frames]
        self.assertLess(order.index("sub"), order.index("push/run-delta"))
        scheduler.close()

    async def test_single_large_authoritative_frame_is_not_treated_as_backlog(self):
        transport = RecordingTransport()
        reasons = []
        scheduler = traffic.EgressScheduler(transport.send_plaintext, agent.encode_message,
                                            budgets=traffic.EgressBudgets(state_hard=100_000),
                                            on_overflow=reasons.append)
        self.assertTrue(scheduler.post(b"s" * 500_000, traffic.STATE))
        self.assertEqual(reasons, [])
        scheduler.close()

    async def test_lagging_stream_degrades_to_bounded_coalesced_snapshot(self):
        transport = RecordingTransport()
        transport.gate = asyncio.Event()
        budgets = traffic.EgressBudgets(stream=64 * 1024)
        scheduler = traffic.EgressScheduler(transport.send_plaintext, agent.encode_message, budgets=budgets)
        builds = []

        def build():
            builds.append(1)
            return {"type": "push/run-event", "payload": {"snapshot": True}}

        for index in range(5000):
            scheduler.post_stream("chat:event", agent.encode_message({"type": "push/run-delta", "payload": {"seq": index, "t": "x" * 200}}), build)
            self.assertLessEqual(scheduler.queued_bytes(traffic.STREAM), 64 * 1024 + 4096)
        self.assertGreater(scheduler.stats["stream_resyncs"], 0)
        transport.gate.set()
        await asyncio.sleep(0.05)
        self.assertEqual(len(builds), 1)
        self.assertTrue(transport.frames[-1]["payload"].get("snapshot"))
        scheduler.close()

    async def test_unbounded_state_backlog_disconnects_slow_consumer(self):
        transport = RecordingTransport()
        transport.gate = asyncio.Event()
        reasons = []
        budgets = traffic.EgressBudgets(state_hard=100_000)
        scheduler = traffic.EgressScheduler(transport.send_plaintext, agent.encode_message,
                                            budgets=budgets, on_overflow=reasons.append)
        for _ in range(20):
            scheduler.post(b"s" * 10_000, traffic.STATE)
        self.assertTrue(reasons)
        self.assertLessEqual(scheduler.queued_bytes(traffic.STATE), 100_000)
        scheduler.close()


class AdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_bulk_flood_is_bounded_and_control_keeps_reserved_capacity(self):
        admission = traffic.Admission([
            traffic.AdmissionClass("control", 2, 8, 10_000),
            traffic.AdmissionClass("bulk", 2, 10, 10_000),
        ])
        release = asyncio.Event()
        ran = []

        def slow():
            async def run():
                await release.wait()
            return run

        accepted = sum(admission.submit("bulk", slow(), 10) for _ in range(1000))
        self.assertEqual(accepted, 12)
        self.assertEqual(len(admission.tasks), 2)  # waiting work is not parked tasks

        async def control():
            ran.append("control")
        self.assertTrue(admission.submit("control", lambda: control()))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(ran, ["control"])
        release.set()
        for _ in range(20):
            await asyncio.sleep(0)
        self.assertEqual(admission.snapshot()["bulk"]["waiting"], 0)
        await admission.close()

    def test_message_classes(self):
        self.assertEqual(ws_general._admission_class("runs/cancel"), "control")
        self.assertEqual(ws_general._admission_class("chats/get"), "bulk")
        self.assertEqual(ws_general._admission_class("terminal/kill"), "general")
        self.assertEqual(ws_general._lane_for({"id": "x", "type": "client/register/response"}), traffic.CONTROL)
        self.assertEqual(ws_general._lane_for({"id": "x", "type": "chats/get/response"}), traffic.BULK)
        self.assertEqual(ws_general._lane_for({"type": "push/run-delta"}), traffic.STREAM)
        self.assertEqual(ws_general._lane_for({"type": "push/run-status"}), traffic.STATE)
        self.assertEqual(ws_general._lane_for({"type": "push/client-http-cancel"}), traffic.CONTROL)


class RelayFlowControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        etna_registry.CLIENT_SESSIONS.clear()
        etna_registry.HTTP_STREAMS.clear()
        etna_registry.RELAY_CLIENTS.clear()

    async def test_consumption_returns_credit_in_sender_units(self):
        posted = []

        class Session:
            def post(self, message):
                posted.append(message)

        stream = etna_registry.RelayStream(Session(), "relay", window=1000)
        for _ in range(10):
            stream.put({"event": "chunk", "data": "😀" * 50, "n": 100})
        self.assertEqual(stream.bytes, 1000)
        for _ in range(10):
            await stream.get(1)
        credits = [message["payload"]["bytes"] for message in posted if message["type"] == "push/client-http-credit"]
        self.assertEqual(sum(credits), 1000)
        self.assertEqual(stream.bytes, 0)

    async def test_non_credit_client_backlog_is_hard_capped(self):
        class Session:
            def post(self, message):
                pass

        stream = etna_registry.RelayStream(Session(), "relay")
        chunk = "x" * (1024 * 1024)
        for _ in range(40):
            stream.put({"event": "chunk", "data": chunk})
        self.assertLessEqual(stream.bytes, etna_registry.RELAY_HARD_CAP_BYTES)
        first = await stream.get(1)
        self.assertEqual(first["event"], "error")

    async def test_stream_request_advertises_window(self):
        sent = []

        class Session:
            async def send(self, message):
                sent.append(message)
                if message["type"] == "push/client-http-request":
                    relay_id = message["payload"]["relay_id"]
                    etna_registry.resolve_http_event(relay_id, {"event": "headers", "status": 200})
                    etna_registry.resolve_http_event(relay_id, {"event": "chunk", "data": "abc", "n": 3})
                    etna_registry.resolve_http_event(relay_id, {"event": "done"})

            def post(self, message):
                sent.append(message)

        etna_registry.register_client("device", Session())
        chunks = [chunk async for chunk in etna_registry.relay_http_stream("device", "http://x/v1/chat/completions")]
        self.assertEqual(chunks, ["abc"])
        request = next(message for message in sent if message["type"] == "push/client-http-request")
        self.assertEqual(request["payload"]["flow"]["window_bytes"], etna_registry.RELAY_WINDOW_BYTES)


_SAVED_CONFIG: tuple = ()


def setUpModule():
    # config.CONFIG_DIR is fixed by whichever module imported it first; pin
    # this module's storage to a private directory regardless of test order.
    global _SAVED_CONFIG
    from vulcan import config as cfg
    _SAVED_CONFIG = (cfg.CONFIG_DIR, cfg.CHATS_DIR)
    cfg.CONFIG_DIR = Path(tempfile.mkdtemp(prefix="vulcan-traffic-"))
    cfg.CHATS_DIR = cfg.CONFIG_DIR / "chats"


def tearDownModule():
    from vulcan import config as cfg
    cfg.CONFIG_DIR, cfg.CHATS_DIR = _SAVED_CONFIG


if __name__ == "__main__":
    unittest.main()
