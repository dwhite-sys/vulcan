"""Conditional transcript transfer and duplicate-load admission regressions."""
import asyncio
import json
import unittest
from unittest import mock

from vulcan.tests.test_traffic_architecture import RecordingTransport, agent, base_chat, ws_general


class SubscriptionCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = RecordingTransport()
        self.session = ws_general.GeneralWSSession(self.transport)
        self.session.authenticated = True
        self.chat = base_chat("conditional")
        self.chat["events"] = [{"id": "history", "type": "assistant_text", "content": "body " * 1000}]
        self.loader = mock.patch.object(ws_general.chat_store, "load_chat", side_effect=lambda *a, **k: json.loads(json.dumps(self.chat)))
        self.loader_mock = self.loader.start()

    async def asyncTearDown(self):
        self.loader.stop()
        agent.MANAGER.unsubscribe(self.session)
        self.session.cleanup()

    async def subscribe(self, request_id, **extra):
        await self.session.handle_message({"id": request_id, "type": "runs/subscribe", "payload": {
            "chat_id": "conditional", "branch_refs": True, "include_chat": True, **extra,
        }})
        return next(frame for frame in self.transport.frames if frame.get("id") == request_id)

    async def test_matching_revision_omits_transcript_but_retains_state_and_seqs(self):
        self.chat["events"][0]["content"] = "x" * 3_000_000
        first = (await self.subscribe("first"))["payload"]
        second = await self.subscribe("second", known_revision=first["chat_revision"])
        self.assertTrue(second["payload"]["chat_unchanged"])
        self.assertNotIn("chat", second["payload"])
        self.assertEqual(second["payload"]["status"], "idle")
        self.assertEqual(second["payload"]["seqs"], {})
        self.assertLess(len(json.dumps(second)), 500)

    async def test_legacy_full_snapshot_and_state_only_contracts_remain_supported(self):
        full = (await self.subscribe("full"))["payload"]
        self.assertIn("chat", full)
        state = (await self.subscribe("state", include_chat=False))["payload"]
        self.assertEqual(state["status"], "idle")
        self.assertNotIn("chat", state)

    async def test_encoding_failure_releases_reservation_and_allows_retry(self):
        with mock.patch.object(self.session, "_encode_subscription", side_effect=ValueError("cannot encode")):
            first = await self.subscribe("failed")
        self.assertEqual(first["type"], "error")
        self.assertEqual(self.session._subscribing_chats, set())
        self.assertIn("chat", (await self.subscribe("retry"))["payload"])

    async def test_missing_chat_never_validates_a_null_snapshot(self):
        import hashlib
        with mock.patch.object(ws_general.chat_store, "load_chat", return_value=None):
            result = (await self.subscribe("missing", known_revision=hashlib.sha256(b"null").hexdigest()))["payload"]
        self.assertIsNone(result["chat"])
        self.assertNotIn("chat_unchanged", result)

    async def test_changed_history_with_same_count_and_timestamp_sends_snapshot(self):
        first = (await self.subscribe("first"))["payload"]
        self.chat["events"][0]["content"] = "edited earlier event"
        second = (await self.subscribe("second", known_revision=first["chat_revision"]))["payload"]
        self.assertNotIn("chat_unchanged", second)
        self.assertNotEqual(second["chat_revision"], first["chat_revision"])
        self.assertEqual(second["chat"]["events"][0]["content"], "edited earlier event")

    async def test_metadata_and_branch_edits_invalidate_revision(self):
        first = (await self.subscribe("first"))["payload"]
        self.chat["branching"] = {"version": 1, "currentBranchId": "b", "nodes": [], "branches": []}
        second = (await self.subscribe("second", known_revision=first["chat_revision"]))["payload"]
        self.assertIn("chat", second)
        self.chat["title"] = "renamed"
        third = (await self.subscribe("third", known_revision=second["chat_revision"]))["payload"]
        self.assertEqual(third["chat"]["title"], "renamed")

    async def test_duplicate_is_rejected_before_another_read_or_encode(self):
        self.transport.gate = asyncio.Event()
        first = asyncio.create_task(self.subscribe("first"))
        await asyncio.sleep(0.02)
        second = asyncio.create_task(self.subscribe("duplicate"))
        await asyncio.sleep(0.02)
        self.transport.gate.set()
        replies = await asyncio.gather(first, second)
        self.assertEqual(self.loader_mock.call_count, 1)
        self.assertEqual(sum("chat" in r.get("payload", {}) for r in replies), 1)
        error = next(r for r in replies if r["type"] == "error")
        self.assertIn("already in progress", error["payload"]["message"])
        self.assertEqual(self.session._subscribing_chats, set())
        self.assertIn("chat", (await self.subscribe("retry"))["payload"])

    async def test_active_revision_tracks_stream_content_and_sequence(self):
        run = agent.AgentRun(chat=self.chat, options={}, manager=agent.MANAGER, run_id="active-conditional")
        agent.MANAGER.runs["conditional"] = run
        try:
            first = (await self.subscribe("first"))["payload"]
            second = (await self.subscribe("second", known_revision=first["chat_revision"]))["payload"]
            self.assertTrue(second["chat_unchanged"])
            run.stream_event({"type": "text_delta", "delta": "new content"}, "turn")
            run.flush_deltas()
            third = (await self.subscribe("third", known_revision=first["chat_revision"]))["payload"]
            self.assertNotEqual(third["chat_revision"], first["chat_revision"])
            self.assertIn("chat", third)
            self.assertEqual(third["seqs"], dict(run.stream_seq))
        finally:
            agent.MANAGER.runs.pop("conditional", None)
