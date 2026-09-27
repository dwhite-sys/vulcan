"""Persistence architecture regressions: mutation-sized writes, reference-based
branch topology with legacy migration, metadata-sized sidebar summaries."""

import asyncio
import copy
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

TEST_DIR = Path(tempfile.mkdtemp(prefix="vulcan-persistence-"))
os.environ["HOME"] = str(TEST_DIR)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from vulcan import agent_runtime as agent  # noqa: E402
from vulcan import chats  # noqa: E402


def event(event_id: str, kind: str = "assistant_text", content: str = "", **extra) -> dict:
    return {"id": event_id, "type": kind, "content": content or f"content of {event_id}",
            "timestamp": "2026-09-01T00:00:00Z", "status": "complete", **extra}


def make_chat(chat_id: str, count: int) -> dict:
    events = [event(f"{chat_id}-u0", "user_message", "start")]
    events += [event(f"{chat_id}-e{index}", content=f"historical answer {index} " + "x" * 200) for index in range(1, count)]
    return {"schemaVersion": 2, "id": chat_id, "title": "T", "createdAt": "c", "updatedAt": "u", "events": events}


class StatementTrace:
    def __init__(self):
        self.statements: list[str] = []

    def __enter__(self):
        chats._database().set_trace_callback(self.statements.append)
        return self

    def __exit__(self, *args):
        chats._database().set_trace_callback(None)

    def count(self, needle: str) -> int:
        return sum(needle in statement for statement in self.statements)


def checkpoint_for(chat: dict, base: int, changed_positions: list[int], persisted_branching=None) -> chats.RunCheckpoint:
    events = chat["events"]
    return chats.RunCheckpoint(
        chat_id=chat["id"],
        metadata_json=json.dumps({key: value for key, value in chat.items() if key not in ("events", "tags", "branching")}),
        branching=chat.get("branching"),
        branching_replaced=chat.get("branching") is not persisted_branching,
        has_branching="branching" in chat,
        created_at=chat.get("createdAt"), updated_at=chat.get("updatedAt"),
        base=base, path_ids=tuple(item["id"] for item in events),
        changed=tuple((position, json.dumps(events[position])) for position in changed_positions),
        prefix_events=tuple(events[:base]),
    )


class IncrementalCheckpointTests(unittest.TestCase):
    def test_one_event_checkpoint_writes_one_event_and_no_fts_scans(self):
        chat = make_chat("inc-big", 2000)
        chats.save_chat(chat)
        base = len(chat["events"])
        chat["events"].append(event("inc-big-new", content="freshly streamed kumquat answer"))
        with StatementTrace() as trace:
            mode = chats.apply_run_checkpoint(checkpoint_for(chat, base, [base]))
        self.assertEqual(mode, "incremental")
        self.assertEqual(trace.count("INSERT INTO chat_events"), 1)
        self.assertEqual(trace.count("DELETE FROM chat_events WHERE chat_id = ?\n"), 0)
        # FTS maintenance is rowid-addressed, never a per-chat scan.
        self.assertFalse(any("transcript_search WHERE chat_id" in item for item in trace.statements))
        self.assertEqual(chats.load_chat("inc-big")["events"][-1]["content"], "freshly streamed kumquat answer")
        hits = chats.search_current_transcripts("kumquat")
        self.assertEqual(hits["chat_ids"], ["inc-big"])

    def test_updating_an_event_replaces_its_search_rows(self):
        chat = make_chat("inc-update", 3)
        chats.save_chat(chat)
        base = len(chat["events"])
        chat["events"].append(event("inc-update-live", content="partial pomegranate"))
        chats.apply_run_checkpoint(checkpoint_for(chat, base, [base]))
        chat["events"][-1]["content"] = "final persimmon"
        chats.apply_run_checkpoint(checkpoint_for(chat, base, [base]))
        self.assertEqual(chats.search_current_transcripts("pomegranate")["chat_ids"], [])
        self.assertEqual(chats.search_current_transcripts("persimmon")["chat_ids"], ["inc-update"])

    def test_huge_event_is_durable_immediately_and_indexed_after(self):
        chat = make_chat("inc-huge", 3)
        chats.save_chat(chat)
        base = len(chat["events"])
        chat["events"].append(event("inc-huge-live", content="early draft tangerine " + "y " * 50_000))
        chats.apply_run_checkpoint(checkpoint_for(chat, base, [base]))
        chats.wait_for_index()
        chat["events"][-1]["content"] = "final answer mangosteen " + "z " * 60_000
        started = time.perf_counter()
        chats.apply_run_checkpoint(checkpoint_for(chat, base, [base]))
        elapsed = time.perf_counter() - started
        # The canonical row is durable before derived FTS work runs.
        self.assertEqual(chats.load_chat("inc-huge")["events"][-1]["content"], chat["events"][-1]["content"])
        self.assertTrue(chats.wait_for_index())
        self.assertEqual(chats.search_current_transcripts("mangosteen")["chat_ids"], ["inc-huge"])
        self.assertEqual(chats.search_current_transcripts("tangerine")["chat_ids"], [])
        self.assertLess(elapsed, 1.0)

    def test_checkpoint_cost_does_not_scale_with_history(self):
        timings = {}
        for size in (100, 4000):
            chat = make_chat(f"scale-{size}", size)
            chats.save_chat(chat)
            base = len(chat["events"])
            chat["events"].append(event(f"scale-{size}-live"))
            started = time.perf_counter()
            for index in range(20):
                chat["events"][-1]["content"] = f"revision {index}"
                chats.apply_run_checkpoint(checkpoint_for(chat, base, [base]))
            timings[size] = time.perf_counter() - started
        # 40x more history must not mean anything close to 40x the cost.
        self.assertLess(timings[4000], timings[100] * 6 + 0.05, timings)

    def test_diverged_storage_falls_back_to_a_complete_save(self):
        chat = make_chat("inc-fallback", 3)
        # The initial save never happened: the checkpoint must still persist it all.
        base = len(chat["events"])
        chat["events"].append(event("inc-fallback-live"))
        mode = chats.apply_run_checkpoint(checkpoint_for(chat, base, [base]))
        self.assertEqual(mode, "full")
        self.assertEqual(chats.load_chat("inc-fallback")["events"], chat["events"])

    def test_full_save_only_rewrites_changed_rows(self):
        chat = make_chat("diff-save", 500)
        chats.save_chat(chat)
        chat["events"][250]["content"] = "edited"
        with StatementTrace() as trace:
            chats.save_chat(chat)
        self.assertEqual(trace.count("INSERT INTO chat_events"), 1)
        self.assertEqual(chats.load_chat("diff-save")["events"], chat["events"])


class RunCheckpointIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_checkpoints_are_ordered_and_final_state_is_durable(self):
        chat = make_chat("run-ordered", 50)
        manager = agent.RunManager()

        async def provider(run, messages, tools, turn_id):
            for index in range(200):
                run.stream_event({"type": "text_delta", "delta": f"{index} "}, turn_id)
                if index % 40 == 0:
                    run.schedule_checkpoint()
                    await asyncio.sleep(0)
            return {"thinking": "", "content": "", "toolCalls": [], "providerTerminal": True}

        chat["events"].append(event("run-ordered-user", "user_message", "go"))
        from unittest import mock
        with mock.patch.object(agent, "_provider_response", provider):
            run = await manager.start_async(chat, {"settings": {}})
            await asyncio.wait_for(run.task, timeout=5)
        stored = chats.load_chat("run-ordered")
        self.assertEqual(stored["events"], json.loads(json.dumps(run.chat["events"])))
        self.assertEqual(stored["events"][-1]["content"], "".join(f"{index} " for index in range(200)))
        self.assertEqual(stored["events"][-1]["status"], "complete")


def legacy_branch_chat(chat_id: str) -> dict:
    root_user = event("u1", "user_message", "original question")
    root_answer = event("a1", content="original answer about apricots")
    edit_user = event("u1-edit", "user_message", "edited question")
    edit_answer = event("a1-edit", content="edited answer about blueberries")
    return {
        "schemaVersion": 2, "id": chat_id, "title": "Branchy", "createdAt": "c", "updatedAt": "u",
        "events": [edit_user, edit_answer],
        "branching": {
            "version": 1, "currentBranchId": "edit",
            "nodes": [
                {"event": root_user, "parentId": None},
                {"event": root_answer, "parentId": "u1"},
                {"event": edit_user, "parentId": None},
                {"event": edit_answer, "parentId": "u1-edit"},
            ],
            "branches": [
                {"id": "root", "parentBranchId": None, "origin": "root", "title": "Main branch", "titleSource": "auto",
                 "createdAt": "c", "updatedAt": "u-root", "headEventId": "a1"},
                {"id": "edit", "parentBranchId": "root", "origin": "edit", "title": "Edited", "titleSource": "auto",
                 "createdAt": "c2", "updatedAt": "u", "headEventId": "a1-edit"},
            ],
        },
    }


def write_legacy_rows(chat: dict) -> None:
    """Store a chat exactly as the pre-normalization server did."""
    metadata = {key: value for key, value in chat.items() if key not in ("events", "tags")}
    with chats._DB_LOCK, chats._database() as connection:
        connection.execute(
            "INSERT OR REPLACE INTO chats(id, metadata_json, created_at, updated_at) VALUES(?,?,?,?)",
            (chat["id"], json.dumps(metadata), chat["createdAt"], chat["updatedAt"]),
        )
        for position, item in enumerate(chat["events"]):
            connection.execute(
                "INSERT INTO chat_events(chat_id,event_id,position,event_type,run_id,turn_id,timestamp,payload_json) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (chat["id"], item["id"], position, item["type"], None, None, item["timestamp"], json.dumps(item)),
            )
        chats._reindex_chat_full(connection, chat["id"])


class BranchNormalizationTests(unittest.TestCase):
    def test_legacy_embedded_graph_loads_identically_and_migrates(self):
        original = legacy_branch_chat("legacy-branchy")
        write_legacy_rows(copy.deepcopy(original))
        loaded = chats.load_chat("legacy-branchy")
        self.assertEqual(loaded["events"], original["events"])
        self.assertEqual(loaded["branching"], original["branching"])
        # Readers never write: the verified migration runs on the background writer.
        self.assertTrue(chats.wait_for_index())
        # Storage is now reference-based; off-path payloads live once, canonically.
        with chats._DB_LOCK, chats._database() as connection:
            stored = json.loads(connection.execute(
                "SELECT metadata_json FROM chats WHERE id = 'legacy-branchy'").fetchone()[0])
            off_path = {row[0] for row in connection.execute(
                "SELECT event_id FROM branch_events WHERE chat_id = 'legacy-branchy'")}
        self.assertTrue(all("event" not in node and "eventId" in node for node in stored["branching"]["nodes"]))
        self.assertEqual(off_path, {"u1", "a1"})
        self.assertNotIn("apricots", json.dumps(stored))
        # Second load after migration is identical as well.
        self.assertEqual(chats.load_chat("legacy-branchy"), loaded)

    def test_reference_wire_form_round_trips(self):
        original = legacy_branch_chat("ref-roundtrip")
        chats.save_chat(copy.deepcopy(original))
        compact = chats.load_chat("ref-roundtrip", branch_refs=True)
        self.assertTrue(all("event" not in node for node in compact["branching"]["nodes"]))
        self.assertEqual({item["id"] for item in compact["branching"]["offPathEvents"]}, {"u1", "a1"})
        # A renderer saving the compact form back loses nothing.
        chats.save_chat(compact)
        self.assertEqual(chats.load_chat("ref-roundtrip")["branching"], original["branching"])

    def test_branch_search_covers_off_path_events_after_normalization(self):
        chats.save_chat(legacy_branch_chat("branch-search"))
        result = chats.search_branches("branch-search", "apricots")
        self.assertEqual(result["branch_ids"], ["root"])
        self.assertEqual(chats.search_current_transcripts("apricots")["chat_ids"], [])
        self.assertEqual(chats.search_current_transcripts("blueberries")["chat_ids"], ["branch-search"])

    def test_switching_branch_moves_events_between_canonical_tables(self):
        chat = legacy_branch_chat("switch-branch")
        chats.save_chat(copy.deepcopy(chat))
        switched = copy.deepcopy(chat)
        switched["events"] = [chat["branching"]["nodes"][0]["event"], chat["branching"]["nodes"][1]["event"]]
        switched["branching"]["currentBranchId"] = "root"
        chats.save_chat(switched)
        loaded = chats.load_chat("switch-branch")
        self.assertEqual([item["id"] for item in loaded["events"]], ["u1", "a1"])
        by_id = {node["event"]["id"]: node for node in loaded["branching"]["nodes"]}
        self.assertEqual(set(by_id), {"u1", "a1", "u1-edit", "a1-edit"})
        self.assertEqual(chats.search_current_transcripts("apricots")["chat_ids"], ["switch-branch"])
        self.assertEqual(chats.search_branches("switch-branch", "blueberries")["branch_ids"], ["edit"])


class ReaderIsolationTests(unittest.TestCase):
    def test_navigation_reads_never_wait_for_the_writer(self):
        import threading
        chat = make_chat("reader-free", 30)
        chats.save_chat(chat)
        holding, release = threading.Event(), threading.Event()

        def slow_writer():
            # A long background write (e.g. indexing a huge tool result).
            with chats._DB_LOCK, chats._database() as connection:
                connection.execute("UPDATE chats SET updated_at = 'writing' WHERE id = 'reader-free'")
                connection.execute("INSERT INTO fts_rowids(chat_id, event_id) VALUES('reader-free', 'uncommitted')")
                holding.set()
                release.wait(10)

        writer = threading.Thread(target=slow_writer)
        writer.start()
        self.assertTrue(holding.wait(5))
        try:
            started = time.perf_counter()
            loaded = chats.load_chat("reader-free")
            listed = chats.load_chat_summaries()
            found = chats.search_current_transcripts("historical")
            elapsed = time.perf_counter() - started
        finally:
            release.set()
            writer.join()
        self.assertLess(elapsed, 1.0)
        self.assertEqual(loaded["events"], chat["events"])
        self.assertIn("reader-free", [item["id"] for item in listed])
        self.assertIn("reader-free", found["chat_ids"])


class SummaryTests(unittest.TestCase):
    def test_summaries_never_parse_metadata(self):
        chats.save_chat(legacy_branch_chat("summary-cheap"))
        with chats._DB_LOCK, chats._database() as connection:
            # Corrupt the (potentially huge) metadata column: summaries must not care.
            connection.execute("UPDATE chats SET metadata_json = '{broken' WHERE id = 'summary-cheap'")
        summary = next(item for item in chats.load_chat_summaries() if item["id"] == "summary-cheap")
        self.assertEqual(summary["title"], "Branchy")
        self.assertEqual(summary["events"], [])
        self.assertTrue(summary["_summaryOnly"])
        self.assertNotIn("branching", summary)
        with chats._DB_LOCK, chats._database() as connection:
            connection.execute("DELETE FROM chats WHERE id = 'summary-cheap'")

    def test_legacy_rows_backfill_summary_once(self):
        write_legacy_rows(legacy_branch_chat("summary-backfill"))
        summary = next(item for item in chats.load_chat_summaries() if item["id"] == "summary-backfill")
        self.assertEqual(summary["title"], "Branchy")
        with chats._DB_LOCK, chats._database() as connection:
            self.assertIsNotNone(connection.execute(
                "SELECT summary_json FROM chats WHERE id = 'summary-backfill'").fetchone()[0])

    def test_summary_only_upsert_cannot_truncate_transcript(self):
        chat = make_chat("summary-guard", 5)
        chats.save_chat(chat)
        chats.save_chat({"schemaVersion": 2, "id": "summary-guard", "title": "Renamed", "folderId": "folder",
                         "events": [], "_summaryOnly": True})
        loaded = chats.load_chat("summary-guard")
        self.assertEqual(loaded["events"], chat["events"])
        self.assertEqual(loaded["folderId"], "folder")
        self.assertEqual(loaded["title"], "Renamed")
        self.assertNotIn("_summaryOnly", loaded)


_SAVED_CONFIG: tuple = ()


def setUpModule():
    # config.CONFIG_DIR is fixed by whichever module imported it first; pin
    # this module's storage to a private directory regardless of test order.
    global _SAVED_CONFIG
    from vulcan import config as cfg
    _SAVED_CONFIG = (cfg.CONFIG_DIR, cfg.CHATS_DIR)
    cfg.CONFIG_DIR = Path(tempfile.mkdtemp(prefix="vulcan-persistence-"))
    cfg.CHATS_DIR = cfg.CONFIG_DIR / "chats"


def tearDownModule():
    from vulcan import config as cfg
    cfg.CONFIG_DIR, cfg.CHATS_DIR = _SAVED_CONFIG


if __name__ == "__main__":
    unittest.main()
