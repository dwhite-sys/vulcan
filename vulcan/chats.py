"""
vulcan/chats.py — Server-side chat persistence.

Chats and their ordered, lossless event records live in ~/.vulcan/chats.sqlite3.
Legacy ~/.vulcan/chats/<chat-uuid>/chat.json snapshots are imported on demand.
The public API continues to return the exact existing client-side Chat shape.
"""

import asyncio
import json
import logging
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from vulcan import config as cfg


logger = logging.getLogger("vulcan.chats")
_DB_LOCK = threading.RLock()
_QUOTE_REFERENCE = re.compile(r"\ue000vulcan-(?:quote|reference|element):[A-Za-z0-9_-]+\ue001")


def searchable_message_content(event: dict) -> str:
    """Internal rich-composer reference tokens are not user-authored search text."""
    content = str(event.get("content", ""))
    if event.get("type") == "user_message" and (event.get("quotes") or event.get("references") or event.get("elements")):
        content = _QUOTE_REFERENCE.sub("", content)
    return content.strip()


def transcript_event_search_text(event: dict) -> str:
    """Server-side mirror of the renderer's searchable transcript projection."""
    event_type = str(event.get("type", ""))
    if event_type in ("user_message", "system_message", "assistant_text", "reasoning"):
        # Keep raw content here so exact hit offsets line up with the renderer.
        # Legacy recall/tag projections may strip internal composer tokens separately.
        return str(event.get("content", "") or "")
    if event_type == "tool":
        parts = [str(event.get("tool", "") or "")]
        for value in (event.get("arguments"), event.get("result")):
            if value is None:
                continue
            try:
                parts.append(json.dumps(value, default=str, ensure_ascii=False))
            except Exception:
                parts.append(str(value))
        return "\n".join(part for part in parts if part)
    if event_type == "presented_file":
        file_meta = event.get("file") or {}
        return "\n".join(str(file_meta.get(key, "") or "") for key in ("name", "path") if file_meta.get(key))
    if event_type == "panel":
        panel = event.get("panel") or {}
        return str(panel.get("name", "") or "")
    return ""


# ── Execution domain ──────────────────────────────────────────────────────────
#
# Chat storage gets its own small executor instead of the process-wide default
# pool: SQLite writes are serialized by _DB_LOCK anyway, and a large transcript
# job must never occupy the workers that filesystem/Docker/terminal work needs.

_DB_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="vulcan-chat-db")
_DB_QUEUED = 0
_DB_PEAK_QUEUED = 0
_DB_LAST_SECONDS = 0.0
_DB_PEAK_SECONDS = 0.0


async def run_db(function: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Run one chat-storage job on the dedicated DB executor."""
    global _DB_QUEUED, _DB_PEAK_QUEUED

    def job() -> Any:
        global _DB_QUEUED, _DB_LAST_SECONDS, _DB_PEAK_SECONDS
        started = time.perf_counter()
        try:
            return function(*args, **kwargs)
        finally:
            _DB_QUEUED -= 1
            _DB_LAST_SECONDS = time.perf_counter() - started
            _DB_PEAK_SECONDS = max(_DB_PEAK_SECONDS, _DB_LAST_SECONDS)

    _DB_QUEUED += 1
    _DB_PEAK_QUEUED = max(_DB_PEAK_QUEUED, _DB_QUEUED)
    return await asyncio.get_running_loop().run_in_executor(_DB_EXECUTOR, job)


def db_metrics() -> dict:
    return {
        "queued": _DB_QUEUED,
        "peak_queued": _DB_PEAK_QUEUED,
        "last_ms": _DB_LAST_SECONDS * 1000,
        "peak_ms": _DB_PEAK_SECONDS * 1000,
    }


# ── Branch topology ───────────────────────────────────────────────────────────
#
# Durable branch topology is reference-based: nodes are {eventId, parentId}.
# Events on the current path are canonical in chat_events; events that exist
# only on other branches are canonical in branch_events. Older databases (and
# older renderers) embed complete event objects in every node; those are read
# transparently and normalized on write / lazily on load.


def _node_event_id(node: Any) -> str:
    if not isinstance(node, dict):
        return ""
    event = node.get("event")
    if isinstance(event, dict):
        return str(event.get("id", "") or "")
    return str(node.get("eventId", "") or "")


def _is_branch_graph(branching: Any) -> bool:
    return (
        isinstance(branching, dict)
        and branching.get("version") == 1
        and isinstance(branching.get("nodes"), list)
        and isinstance(branching.get("branches"), list)
    )


def _has_embedded_nodes(branching: Any) -> bool:
    return _is_branch_graph(branching) and any(
        isinstance(node, dict) and isinstance(node.get("event"), dict) for node in branching["nodes"]
    )


def _normalize_branching(
    branching: Any, path_ids: list[str], updated_at: Any = None,
) -> tuple[Any, dict[str, dict]]:
    """Return (reference-form branching, embedded off-path event payloads).

    Pure: never mutates its input. The current linear projection (`path_ids`)
    is merged into the graph exactly as before: unseen events are appended
    with the previous path event as parent, and the current branch's head
    moves to the last path event. Malformed/unknown branching is returned
    unchanged so no client data is silently discarded.
    """
    if not _is_branch_graph(branching):
        return branching, {}
    parents: dict[str, str | None] = {}
    order: list[str] = []
    embedded: dict[str, dict] = {}
    for node in branching["nodes"]:
        event_id = _node_event_id(node)
        if not event_id or event_id in parents:
            continue
        parent = node.get("parentId")
        parents[event_id] = str(parent) if parent else None
        order.append(event_id)
        if isinstance(node.get("event"), dict):
            embedded[event_id] = node["event"]
    for event in branching.get("offPathEvents") or []:
        if isinstance(event, dict) and event.get("id"):
            embedded.setdefault(str(event["id"]), event)

    branches = [dict(branch) if isinstance(branch, dict) else branch for branch in branching["branches"]]
    current_branch_id = branching.get("currentBranchId")
    if current_branch_id:
        previous: str | None = None
        for event_id in path_ids:
            if event_id not in parents:
                parents[event_id] = previous
                order.append(event_id)
            previous = event_id
        for branch in branches:
            if isinstance(branch, dict) and branch.get("id") == current_branch_id:
                branch["headEventId"] = previous
                if updated_at is not None:
                    branch["updatedAt"] = updated_at
                break

    normalized = {key: value for key, value in branching.items() if key not in ("nodes", "offPathEvents")}
    normalized["nodes"] = [{"eventId": event_id, "parentId": parents[event_id]} for event_id in order]
    normalized["branches"] = branches
    on_path = set(path_ids)
    off_path = {event_id: event for event_id, event in embedded.items() if event_id not in on_path}
    return normalized, off_path


def _branch_paths_from_topology(
    branching: Any, path_ids: list[str],
) -> tuple[dict[str, list[str]], str | None]:
    """Derive every branch's ordered event-id path from reference topology."""
    if not _is_branch_graph(branching):
        return {}, None
    parents: dict[str, str | None] = {}
    for node in branching["nodes"]:
        event_id = _node_event_id(node)
        if event_id and event_id not in parents:
            parents[event_id] = str(node.get("parentId")) if node.get("parentId") else None
    previous: str | None = None
    for event_id in path_ids:
        if event_id not in parents:
            parents[event_id] = previous
        previous = event_id
    paths: dict[str, list[str]] = {}
    for branch in branching["branches"]:
        if not isinstance(branch, dict) or not branch.get("id"):
            continue
        cursor = str(branch["headEventId"]) if branch.get("headEventId") else None
        reverse: list[str] = []
        seen: set[str] = set()
        while cursor and cursor not in seen and cursor in parents:
            seen.add(cursor)
            reverse.append(cursor)
            cursor = parents[cursor]
        paths[str(branch["id"])] = list(reversed(reverse))
    current = branching.get("currentBranchId")
    return paths, str(current) if current else None


def _embed_branching(branching: Any, by_id: dict[str, dict]) -> Any:
    """Legacy wire form: every node carries its event object (shared refs)."""
    if not _is_branch_graph(branching):
        return branching
    nodes = []
    for node in branching["nodes"]:
        if isinstance(node, dict) and isinstance(node.get("event"), dict):
            nodes.append(node)
            continue
        event = by_id.get(_node_event_id(node))
        if event is not None:
            nodes.append({"event": event, "parentId": node.get("parentId")})
    return {**branching, "nodes": nodes}


def _reference_branching(branching: Any, off_path: dict[str, dict]) -> Any:
    """Compact wire form: reference nodes plus only the off-path payloads."""
    if not _is_branch_graph(branching):
        return branching
    nodes = [
        {"eventId": _node_event_id(node), "parentId": node.get("parentId")}
        for node in branching["nodes"] if _node_event_id(node)
    ]
    return {**branching, "nodes": nodes, "offPathEvents": list(off_path.values())}


# ── Search/index projections (keyed rowids; O(log n) per event) ───────────────


def _fts_key(connection: sqlite3.Connection, chat_id: str, event_id: str) -> int:
    row = connection.execute(
        "SELECT key FROM fts_rowids WHERE chat_id = ? AND event_id = ?", (chat_id, event_id)
    ).fetchone()
    if row is not None:
        return int(row[0])
    return int(connection.execute(
        "INSERT INTO fts_rowids(chat_id, event_id) VALUES(?, ?)", (chat_id, event_id)
    ).lastrowid)


# FTS maintenance for a multi-megabyte message costs ~a second of tokenizing.
# That is derived data, not a durability boundary, so large events are
# committed canonically first and (re)indexed right after, latest-wins.
_INDEX_DEFER_CHARS = 64 * 1024
_DEFERRED_INDEX: set[tuple[str, str]] = set()
_DEFERRED_LOCK = threading.Lock()
_DEFERRED_RUNNING = False


def _index_event(connection: sqlite3.Connection, chat_id: str, event: dict, *, on_current_path: bool,
                 defer_large: bool = True) -> bool:
    """(Re)index one canonical event; returns whether it is transcript-searchable."""
    event_id = str(event.get("id", ""))
    if defer_large:
        text = transcript_event_search_text(event).strip()
        if len(text) > _INDEX_DEFER_CHARS:
            connection.execute(
                "INSERT OR REPLACE INTO transcript_event_meta(chat_id,event_id,timestamp) VALUES(?,?,?)",
                (chat_id, event_id, str(event.get("timestamp", ""))),
            )
            _defer_index(chat_id, event_id)
            return True
    key = _fts_key(connection, chat_id, event_id)
    connection.execute("DELETE FROM chat_search WHERE rowid = ?", (key,))
    connection.execute("DELETE FROM transcript_search WHERE rowid = ?", (key,))
    event_type = event.get("type")
    if on_current_path and event_type in ("user_message", "assistant_text"):
        content = searchable_message_content(event)
        if content:
            connection.execute(
                "INSERT INTO chat_search(rowid,chat_id,event_id,role,content) VALUES(?,?,?,?,?)",
                (key, chat_id, event_id, "user" if event_type == "user_message" else "assistant", content),
            )
    text = transcript_event_search_text(event).strip()
    if text:
        connection.execute(
            "INSERT INTO transcript_search(rowid,chat_id,event_id,event_type,content) VALUES(?,?,?,?,?)",
            (key, chat_id, event_id, str(event_type or ""), text),
        )
        connection.execute(
            "INSERT OR REPLACE INTO transcript_event_meta(chat_id,event_id,timestamp) VALUES(?,?,?)",
            (chat_id, event_id, str(event.get("timestamp", ""))),
        )
        return True
    connection.execute("DELETE FROM transcript_event_meta WHERE chat_id = ? AND event_id = ?", (chat_id, event_id))
    return False


def _defer_index(chat_id: str, event_id: str) -> None:
    global _DEFERRED_RUNNING
    with _DEFERRED_LOCK:
        _DEFERRED_INDEX.add((chat_id, event_id))
        if _DEFERRED_RUNNING:
            return
        _DEFERRED_RUNNING = True
    _DB_EXECUTOR.submit(_run_deferred_index)


def _run_deferred_index() -> None:
    """Index deferred events from their *current* canonical payload.

    Reading the latest stored payload (instead of carrying one) makes these
    jobs order-independent: an older job can never index stale content.
    """
    global _DEFERRED_RUNNING
    while True:
        with _DEFERRED_LOCK:
            if not _DEFERRED_INDEX:
                _DEFERRED_RUNNING = False
                return
            chat_id, event_id = _DEFERRED_INDEX.pop()
        try:
            with _DB_LOCK, _database() as connection:
                row = connection.execute(
                    "SELECT payload_json FROM chat_events WHERE chat_id = ? AND event_id = ?", (chat_id, event_id)
                ).fetchone()
                on_path = row is not None
                if row is None:
                    row = connection.execute(
                        "SELECT payload_json FROM branch_events WHERE chat_id = ? AND event_id = ?", (chat_id, event_id)
                    ).fetchone()
                if row is None:
                    _unindex_event(connection, chat_id, event_id)
                else:
                    _index_event(connection, chat_id, json.loads(row["payload_json"]),
                                 on_current_path=on_path, defer_large=False)
        except Exception:
            logger.exception("Deferred search indexing failed for %s/%s", chat_id, event_id)


def wait_for_index(timeout: float = 30.0) -> bool:
    """Block until deferred search indexing has drained (tests/shutdown)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _DEFERRED_LOCK:
            if not _DEFERRED_INDEX and not _DEFERRED_RUNNING:
                return True
        time.sleep(0.01)
    return False


def _unindex_event(connection: sqlite3.Connection, chat_id: str, event_id: str) -> None:
    row = connection.execute(
        "SELECT key FROM fts_rowids WHERE chat_id = ? AND event_id = ?", (chat_id, event_id)
    ).fetchone()
    if row is not None:
        connection.execute("DELETE FROM chat_search WHERE rowid = ?", (row[0],))
        connection.execute("DELETE FROM transcript_search WHERE rowid = ?", (row[0],))
        connection.execute("DELETE FROM fts_rowids WHERE key = ?", (row[0],))
    connection.execute("DELETE FROM transcript_event_meta WHERE chat_id = ? AND event_id = ?", (chat_id, event_id))
    connection.execute("DELETE FROM chat_current_events WHERE chat_id = ? AND event_id = ?", (chat_id, event_id))
    connection.execute("DELETE FROM branch_event_map WHERE chat_id = ? AND event_id = ?", (chat_id, event_id))


def _rebuild_path_projections(
    connection: sqlite3.Connection, chat_id: str, branching: Any, path_ids: list[str], searchable: set[str],
) -> None:
    """Rebuild the (cheap, B-tree) current/branch path maps for one chat."""
    connection.execute("DELETE FROM chat_current_events WHERE chat_id = ?", (chat_id,))
    connection.execute("DELETE FROM branch_event_map WHERE chat_id = ?", (chat_id,))
    connection.executemany(
        "INSERT OR REPLACE INTO chat_current_events(chat_id,event_id,position) VALUES(?,?,?)",
        [(chat_id, event_id, position) for position, event_id in enumerate(path_ids) if event_id in searchable],
    )
    paths, current_branch_id = _branch_paths_from_topology(branching, path_ids)
    if paths:
        rows = [
            (chat_id, branch_id, event_id, position)
            for branch_id, event_ids in paths.items()
            for position, event_id in enumerate(event_ids) if event_id in searchable
        ]
    elif current_branch_id:
        rows = [(chat_id, current_branch_id, event_id, position)
                for position, event_id in enumerate(path_ids) if event_id in searchable]
    else:
        rows = []
    connection.executemany(
        "INSERT OR REPLACE INTO branch_event_map(chat_id,branch_id,event_id,position) VALUES(?,?,?,?)", rows,
    )


def _searchable_ids(connection: sqlite3.Connection, chat_id: str) -> set[str]:
    return {row[0] for row in connection.execute(
        "SELECT event_id FROM transcript_event_meta WHERE chat_id = ?", (chat_id,)
    )}


def _reindex_chat_full(connection: sqlite3.Connection, chat_id: str) -> None:
    """Rebuild every derived projection for one chat from canonical storage."""
    row = connection.execute("SELECT metadata_json FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if row is None:
        return
    metadata = json.loads(row["metadata_json"])
    events = [json.loads(item["payload_json"]) for item in connection.execute(
        "SELECT payload_json FROM chat_events WHERE chat_id = ? ORDER BY position", (chat_id,)
    )]
    path_ids = [str(event.get("id", "")) for event in events]
    branching = metadata.get("branching")
    canonical: dict[str, dict] = {}
    if _is_branch_graph(branching):
        for node in branching["nodes"]:
            if isinstance(node, dict) and isinstance(node.get("event"), dict):
                canonical[_node_event_id(node)] = node["event"]
    for item in connection.execute("SELECT payload_json FROM branch_events WHERE chat_id = ?", (chat_id,)):
        event = json.loads(item["payload_json"])
        canonical[str(event.get("id", ""))] = event
    on_path = set(path_ids)
    for event in events:
        canonical[str(event.get("id", ""))] = event
    searchable: set[str] = set()
    for event_id, event in canonical.items():
        if event_id and _index_event(connection, chat_id, event, on_current_path=event_id in on_path,
                                     defer_large=False):
            searchable.add(event_id)
    _rebuild_path_projections(connection, chat_id, branching, path_ids, searchable)


# ── Schema and connections ────────────────────────────────────────────────────

_SCHEMA_USER_VERSION = 1
_LOCAL = threading.local()
_SCHEMA_READY: dict[str, int] = {}


def _ensure_schema(connection: sqlite3.Connection) -> None:
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            metadata_json TEXT NOT NULL,
            created_at TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS chat_events (
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            run_id TEXT,
            turn_id TEXT,
            timestamp TEXT,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (chat_id, event_id),
            UNIQUE (chat_id, position)
        );
        CREATE INDEX IF NOT EXISTS chat_events_run ON chat_events(chat_id, run_id, position);
        CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at DESC);
        CREATE TABLE IF NOT EXISTS branch_events (
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (chat_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS fts_rowids (
            key INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            UNIQUE (chat_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS chat_tags (
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            score REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (chat_id, tag)
        );
        CREATE INDEX IF NOT EXISTS chat_tags_tag ON chat_tags(tag);
        CREATE VIRTUAL TABLE IF NOT EXISTS chat_search USING fts5(
            chat_id UNINDEXED,
            event_id UNINDEXED,
            role UNINDEXED,
            content,
            tokenize='unicode61 remove_diacritics 2'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search USING fts5(
            chat_id UNINDEXED,
            event_id UNINDEXED,
            event_type UNINDEXED,
            content,
            tokenize='trigram'
        );
        CREATE TABLE IF NOT EXISTS transcript_event_meta (
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL,
            timestamp TEXT,
            PRIMARY KEY (chat_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS chat_current_events (
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            event_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (chat_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS chat_current_events_position ON chat_current_events(chat_id, position);
        CREATE TABLE IF NOT EXISTS branch_event_map (
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            branch_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (chat_id, branch_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS branch_event_map_position ON branch_event_map(chat_id, branch_id, position);
        CREATE VIRTUAL TABLE IF NOT EXISTS chat_tag_search USING fts5(
            chat_id UNINDEXED,
            tag,
            tokenize='unicode61 remove_diacritics 2'
        );
    """)
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(chats)")}
    if "summary_json" not in columns:
        # Genuinely metadata-sized sidebar projection (backfilled lazily).
        connection.execute("ALTER TABLE chats ADD COLUMN summary_json TEXT")
        connection.commit()

    user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    has_chats = connection.execute("SELECT EXISTS(SELECT 1 FROM chats)").fetchone()[0]
    legacy_indexed = connection.execute("SELECT EXISTS(SELECT 1 FROM chat_search)").fetchone()[0]
    indexed = connection.execute("SELECT EXISTS(SELECT 1 FROM transcript_search)").fetchone()[0]
    meta_indexed = connection.execute("SELECT EXISTS(SELECT 1 FROM transcript_event_meta)").fetchone()[0]
    if user_version < _SCHEMA_USER_VERSION or (has_chats and (not legacy_indexed or not indexed or not meta_indexed)):
        # Derived projections are fully rebuildable from canonical storage.
        # v1 re-keys FTS rows by stable per-event rowids so later maintenance
        # is O(log n) per changed event instead of an FTS scan per save.
        with connection:
            connection.execute("DELETE FROM chat_search")
            connection.execute("DELETE FROM transcript_search")
            connection.execute("DELETE FROM transcript_event_meta")
            connection.execute("DELETE FROM chat_current_events")
            connection.execute("DELETE FROM branch_event_map")
            for row in connection.execute("SELECT id FROM chats").fetchall():
                _reindex_chat_full(connection, row["id"])
            connection.execute(f"PRAGMA user_version = {_SCHEMA_USER_VERSION}")


def _database() -> sqlite3.Connection:
    """Return this thread's connection to the canonical chat database.

    Connections are cached per thread and the schema is (re)checked only when
    SQLite's schema cookie changes, not on every call.
    """
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    path = str(cfg.CONFIG_DIR / "chats.sqlite3")
    connections = getattr(_LOCAL, "connections", None)
    if connections is None:
        connections = _LOCAL.connections = {}
    connection = connections.get(path)
    if connection is None:
        connection = sqlite3.connect(path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connections[path] = connection
    cookie = int(connection.execute("PRAGMA schema_version").fetchone()[0])
    if _SCHEMA_READY.get(path) != cookie:
        _ensure_schema(connection)
        _SCHEMA_READY[path] = int(connection.execute("PRAGMA schema_version").fetchone()[0])
    return connection


# ── Canonical load/save ───────────────────────────────────────────────────────


def _event_row(chat_id: str, position: int, event: dict, payload_json: str) -> tuple:
    return (chat_id, str(event.get("id", "")), position, str(event.get("type", "")), event.get("runId"),
            event.get("turnId"), str(event.get("timestamp", "")), payload_json)


def _off_path_events(connection: sqlite3.Connection, chat_id: str) -> dict[str, dict]:
    return {
        str(row["event_id"]): json.loads(row["payload_json"])
        for row in connection.execute("SELECT event_id, payload_json FROM branch_events WHERE chat_id = ?", (chat_id,))
    }


def _write_metadata(connection: sqlite3.Connection, chat_id: str, metadata: dict,
                    created_at: Any, updated_at: Any) -> None:
    connection.execute(
        "INSERT INTO chats(id, metadata_json, created_at, updated_at, summary_json) VALUES(?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json, "
        "created_at=excluded.created_at, updated_at=excluded.updated_at, summary_json=excluded.summary_json",
        (chat_id, json.dumps(metadata, default=str), str(created_at if created_at is not None else ""),
         str(updated_at if updated_at is not None else ""), json.dumps(_summary_fields(metadata), default=str)),
    )


def _sync_off_path(connection: sqlite3.Connection, chat_id: str, branching: Any,
                   off_path: dict[str, dict], on_path: set[str]) -> tuple[list[dict], list[str]]:
    """Store changed off-path payloads; drop ones now on-path or unreferenced.

    Returns (changed off-path events, removed event ids) for index upkeep.
    """
    existing = {
        str(row["event_id"]): row["payload_json"]
        for row in connection.execute("SELECT event_id, payload_json FROM branch_events WHERE chat_id = ?", (chat_id,))
    }
    changed: list[dict] = []
    for event_id, event in off_path.items():
        payload = json.dumps(event, default=str)
        if existing.get(event_id) != payload:
            connection.execute(
                "INSERT OR REPLACE INTO branch_events(chat_id, event_id, payload_json) VALUES(?,?,?)",
                (chat_id, event_id, payload),
            )
            changed.append(event)
    referenced = {_node_event_id(node) for node in branching["nodes"]} if _is_branch_graph(branching) else set()
    removed: list[str] = []
    for event_id in existing:
        if event_id in on_path or (referenced and event_id not in referenced) or (not referenced and event_id not in off_path):
            connection.execute("DELETE FROM branch_events WHERE chat_id = ? AND event_id = ?", (chat_id, event_id))
            if event_id not in on_path:
                removed.append(event_id)
    return changed, removed


def save_chat(chat: dict) -> dict:
    """Persist a complete chat, writing only what actually changed.

    Rows whose serialized payload and position are unchanged are left alone;
    derived search rows are maintained per changed event. Branch topology is
    stored reference-based. A summary-only sidebar projection (``_summaryOnly``)
    can never replace a transcript: it updates metadata fields only.
    """
    chat_id = chat.get("id")
    if not chat_id:
        raise ValueError("Chat must have an id")
    if chat.get("_summaryOnly"):
        update_chat_metadata(str(chat_id), {
            key: value for key, value in chat.items()
            if key not in ("events", "tags", "branching", "_summaryOnly", "id")
        })
        return chat
    events = chat.get("events", [])
    if not isinstance(events, list):
        raise ValueError("Chat events must be an ordered list")
    path_ids: list[str] = []
    for event in events:
        event_id = str(event.get("id", ""))
        if not event_id:
            raise ValueError("Every chat event must have an id")
        path_ids.append(event_id)
    branching, off_path = _normalize_branching(chat.get("branching"), path_ids, chat.get("updatedAt"))
    # Tags are derived server-owned projections, never client-authored metadata.
    metadata = {key: value for key, value in chat.items() if key not in ("events", "tags", "branching", "_summaryOnly")}
    if "branching" in chat:
        metadata["branching"] = branching
    payloads = [json.dumps(event, default=str) for event in events]
    changed_events: list[dict] = []
    with _DB_LOCK, _database() as connection:
        _write_metadata(connection, str(chat_id), metadata, chat.get("createdAt"), chat.get("updatedAt"))
        existing = {
            str(row["event_id"]): (int(row["position"]), row["payload_json"])
            for row in connection.execute(
                "SELECT event_id, position, payload_json FROM chat_events WHERE chat_id = ?", (chat_id,)
            )
        }
        wanted = {event_id: (position, payloads[position]) for position, event_id in enumerate(path_ids)}
        stale = [event_id for event_id, value in existing.items() if wanted.get(event_id) != value]
        connection.executemany("DELETE FROM chat_events WHERE chat_id = ? AND event_id = ?",
                               [(chat_id, event_id) for event_id in stale])
        inserts = []
        for position, event in enumerate(events):
            event_id = path_ids[position]
            if existing.get(event_id) != wanted[event_id]:
                inserts.append(_event_row(str(chat_id), position, event, payloads[position]))
                changed_events.append(event)
        connection.executemany(
            "INSERT INTO chat_events(chat_id,event_id,position,event_type,run_id,turn_id,timestamp,payload_json) "
            "VALUES(?,?,?,?,?,?,?,?)", inserts,
        )
        on_path = set(path_ids)
        changed_off, removed_off = _sync_off_path(connection, str(chat_id), branching, off_path, on_path)
        # Maintain search rows only for events whose canonical payload or
        # path membership changed.
        moved_off_path = [event_id for event_id in existing if event_id not in on_path]
        for event in changed_events:
            _index_event(connection, str(chat_id), event, on_current_path=True)
        for event in changed_off:
            _index_event(connection, str(chat_id), event, on_current_path=False)
        off_ids = {str(event.get("id")) for event in changed_off}
        for event_id in moved_off_path:
            if event_id in off_ids:
                continue
            if event_id in off_path or connection.execute(
                "SELECT 1 FROM branch_events WHERE chat_id = ? AND event_id = ?", (chat_id, event_id)
            ).fetchone():
                payload = off_path.get(event_id)
                if payload is None:
                    row = connection.execute("SELECT payload_json FROM branch_events WHERE chat_id = ? AND event_id = ?",
                                             (chat_id, event_id)).fetchone()
                    payload = json.loads(row["payload_json"])
                _index_event(connection, str(chat_id), payload, on_current_path=False)
            else:
                _unindex_event(connection, str(chat_id), event_id)
        for event_id in removed_off:
            _unindex_event(connection, str(chat_id), event_id)
        _rebuild_path_projections(connection, str(chat_id), branching, path_ids,
                                  _searchable_ids(connection, str(chat_id)))
    # The transaction is committed before background ONNX indexing can inspect
    # it. Streaming assistant fragments are deliberately ignored by the queue.
    from vulcan import recall
    recall.queue_completed_messages(str(chat_id), changed_events)
    return chat


def update_chat_metadata(chat_id: str, fields: dict) -> bool:
    """Merge small metadata fields without touching events or topology."""
    with _DB_LOCK, _database() as connection:
        row = connection.execute("SELECT metadata_json, created_at FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if row is None:
            return False
        metadata = json.loads(row["metadata_json"])
        metadata.update(fields)
        _write_metadata(connection, chat_id, metadata, metadata.get("createdAt", row["created_at"]), metadata.get("updatedAt"))
    return True


@dataclass(frozen=True)
class RunCheckpoint:
    """Immutable, mutation-sized snapshot of one server-owned run checkpoint.

    Built on the event loop from strings and tuples only, so the DB worker can
    never observe the live chat being mutated by streaming.
    """

    chat_id: str
    metadata_json: str              # chat minus events/tags/branching
    branching: Any                  # the run chat's (client-authored, never run-mutated) branching
    branching_replaced: bool        # False: stored topology is current; just extend it
    has_branching: bool
    created_at: Any
    updated_at: Any
    base: int                       # events before the run's tail (unchanged history)
    path_ids: tuple[str, ...]       # full current path, in order
    changed: tuple[tuple[int, str], ...]   # (position, payload_json) of changed tail events
    prefix_events: tuple[dict, ...]         # history refs, for the full-save fallback only


def apply_run_checkpoint(checkpoint: RunCheckpoint) -> str:
    """Apply one run checkpoint; cost tracks the mutation, not the chat size.

    Returns "incremental", or "full" when storage diverged from the run's
    assumptions (e.g. the initial save failed) and a complete save was needed.
    """
    # One lock scope for check + write: a concurrent client upsert must not
    # slip between the consistency check and the mutation.
    with _DB_LOCK:
        return _apply_run_checkpoint_locked(checkpoint)


def _apply_run_checkpoint_locked(checkpoint: RunCheckpoint) -> str:
    chat_id = checkpoint.chat_id
    path_ids = list(checkpoint.path_ids)
    changed = {position: payload for position, payload in checkpoint.changed}
    with _database() as connection:
        row = connection.execute("SELECT metadata_json FROM chats WHERE id = ?", (chat_id,)).fetchone()
        consistent = row is not None
        if consistent and checkpoint.base:
            count = connection.execute(
                "SELECT COUNT(*) FROM chat_events WHERE chat_id = ? AND position < ?", (chat_id, checkpoint.base)
            ).fetchone()[0]
            last = connection.execute(
                "SELECT event_id FROM chat_events WHERE chat_id = ? AND position = ?", (chat_id, checkpoint.base - 1)
            ).fetchone()
            consistent = count == checkpoint.base and last is not None and last[0] == path_ids[checkpoint.base - 1]
        if consistent:
            existing_tail = {
                int(item["position"]): (str(item["event_id"]), item["payload_json"])
                for item in connection.execute(
                    "SELECT event_id, position, payload_json FROM chat_events WHERE chat_id = ? AND position >= ?",
                    (chat_id, checkpoint.base),
                )
            }
            # Every tail event must be either stored already or carried here.
            consistent = all(
                position in changed or existing_tail.get(position, ("", ""))[0] == path_ids[position]
                for position in range(checkpoint.base, len(path_ids))
            )
    if not consistent:
        _save_checkpoint_fully(checkpoint)
        return "full"

    changed_events: list[tuple[int, dict]] = []
    with _database() as connection:
        stored = json.loads(row["metadata_json"])
        metadata = json.loads(checkpoint.metadata_json)
        topology_replaced = checkpoint.branching_replaced
        source = checkpoint.branching if topology_replaced else stored.get("branching")
        if topology_replaced and checkpoint.has_branching or (not topology_replaced and "branching" in stored):
            branching, off_path = _normalize_branching(source, path_ids, checkpoint.updated_at)
            metadata["branching"] = branching
        else:
            branching, off_path = None, {}
        _write_metadata(connection, chat_id, metadata, checkpoint.created_at, checkpoint.updated_at)

        # Truncate/replace only inside the tail.
        removed_ids = [event_id for position, (event_id, _payload) in existing_tail.items()
                       if position >= len(path_ids) or path_ids[position] != event_id]
        connection.executemany("DELETE FROM chat_events WHERE chat_id = ? AND event_id = ?",
                               [(chat_id, event_id) for event_id in removed_ids])
        for position, payload in sorted(changed.items()):
            event = json.loads(payload)
            if existing_tail.get(position) == (path_ids[position], payload):
                continue
            connection.execute("DELETE FROM chat_events WHERE chat_id = ? AND event_id = ?", (chat_id, path_ids[position]))
            connection.execute(
                "INSERT INTO chat_events(chat_id,event_id,position,event_type,run_id,turn_id,timestamp,payload_json) "
                "VALUES(?,?,?,?,?,?,?,?)", _event_row(chat_id, position, event, payload),
            )
            changed_events.append((position, event))
        on_path = set(path_ids)
        changed_off: list[dict] = []
        removed_off: list[str] = []
        if branching is not None and (topology_replaced or off_path):
            changed_off, removed_off = _sync_off_path(connection, chat_id, branching, off_path, on_path)
        current_branch = branching.get("currentBranchId") if isinstance(branching, dict) else None
        for position, event in changed_events:
            event_id = str(event.get("id", ""))
            if _index_event(connection, chat_id, event, on_current_path=True):
                connection.execute("INSERT OR REPLACE INTO chat_current_events(chat_id,event_id,position) VALUES(?,?,?)",
                                   (chat_id, event_id, position))
                if current_branch and not topology_replaced:
                    connection.execute(
                        "INSERT OR REPLACE INTO branch_event_map(chat_id,branch_id,event_id,position) VALUES(?,?,?,?)",
                        (chat_id, current_branch, event_id, position),
                    )
            else:
                connection.execute("DELETE FROM chat_current_events WHERE chat_id = ? AND event_id = ?", (chat_id, event_id))
                connection.execute("DELETE FROM branch_event_map WHERE chat_id = ? AND event_id = ?", (chat_id, event_id))
        for event in changed_off:
            _index_event(connection, chat_id, event, on_current_path=False)
        for event_id in removed_ids:
            if event_id not in on_path and event_id not in off_path:
                _unindex_event(connection, chat_id, event_id)
        for event_id in removed_off:
            _unindex_event(connection, chat_id, event_id)
        if topology_replaced or removed_ids:
            _rebuild_path_projections(connection, chat_id, branching, path_ids, _searchable_ids(connection, chat_id))
    from vulcan import recall
    recall.queue_completed_messages(chat_id, [event for _position, event in changed_events])
    return "incremental"


def _save_checkpoint_fully(checkpoint: RunCheckpoint) -> None:
    metadata = json.loads(checkpoint.metadata_json)
    tail: list[dict] = []
    changed = dict(checkpoint.changed)
    stored_tail: dict[str, dict] = {}
    with _database() as connection:
        for row in connection.execute(
            "SELECT event_id, payload_json FROM chat_events WHERE chat_id = ?", (checkpoint.chat_id,),
        ):
            stored_tail[str(row["event_id"])] = json.loads(row["payload_json"])
        stored_meta_row = connection.execute("SELECT metadata_json FROM chats WHERE id = ?", (checkpoint.chat_id,)).fetchone()
    for position in range(checkpoint.base, len(checkpoint.path_ids)):
        if position in changed:
            tail.append(json.loads(changed[position]))
        elif checkpoint.path_ids[position] in stored_tail:
            tail.append(stored_tail[checkpoint.path_ids[position]])
        else:
            raise RuntimeError(f"Checkpoint for {checkpoint.chat_id} lacks event {checkpoint.path_ids[position]}")
    chat = {**metadata, "events": [*checkpoint.prefix_events, *tail]}
    stored = json.loads(stored_meta_row["metadata_json"]) if stored_meta_row is not None else {}
    if not checkpoint.branching_replaced and "branching" in stored:
        chat["branching"] = stored["branching"]
    elif checkpoint.has_branching:
        # Storage diverged (e.g. the initial save failed): the run's own
        # branching object is the authority.
        chat["branching"] = checkpoint.branching
    chat.setdefault("id", checkpoint.chat_id)
    save_chat(chat)


def _migrate_legacy_branching(connection: sqlite3.Connection, chat_id: str, metadata: dict,
                              events: list[dict]) -> tuple[Any, dict[str, dict]]:
    """Normalize one chat's legacy embedded branch graph, verifying first.

    Only committed when every reference resolves; otherwise the legacy form is
    kept (it remains fully readable) and the attempt is logged.
    """
    branching = metadata.get("branching")
    path_ids = [str(event.get("id", "")) for event in events]
    normalized, off_path = _normalize_branching(branching, path_ids)
    # The legacy graph is authoritative as stored; do not move any head here.
    if _is_branch_graph(normalized):
        heads = {str(branch.get("id")): branch.get("headEventId") for branch in branching["branches"] if isinstance(branch, dict)}
        for branch in normalized["branches"]:
            if isinstance(branch, dict) and str(branch.get("id")) in heads:
                branch["headEventId"] = heads[str(branch.get("id"))]
                original = next((item for item in branching["branches"]
                                 if isinstance(item, dict) and item.get("id") == branch.get("id")), None)
                if original is not None and "updatedAt" in original:
                    branch["updatedAt"] = original["updatedAt"]
    known = set(path_ids) | set(off_path)
    references_ok = _is_branch_graph(normalized) and all(
        node["eventId"] in known and (node["parentId"] is None or node["parentId"] in known)
        for node in normalized["nodes"]
    ) and all(
        not isinstance(branch, dict) or not branch.get("headEventId") or branch["headEventId"] in known
        for branch in normalized["branches"]
    )
    if not references_ok:
        logger.warning("Legacy branch graph for %s has unresolved references; left unmigrated", chat_id)
        return branching, {event_id: node["event"] for node in branching["nodes"]
                           if isinstance(node, dict) and isinstance(node.get("event"), dict)
                           for event_id in [_node_event_id(node)] if event_id not in set(path_ids)}
    migrated = {**metadata, "branching": normalized}
    connection.execute(
        "UPDATE chats SET metadata_json = ?, summary_json = ? WHERE id = ?",
        (json.dumps(migrated, default=str), json.dumps(_summary_fields(migrated), default=str), chat_id),
    )
    for event_id, event in off_path.items():
        connection.execute(
            "INSERT OR REPLACE INTO branch_events(chat_id, event_id, payload_json) VALUES(?,?,?)",
            (chat_id, event_id, json.dumps(event, default=str)),
        )
    connection.commit()
    return normalized, off_path


def _row_to_chat(connection: sqlite3.Connection, row: sqlite3.Row, *, branch_refs: bool = False) -> dict:
    chat = json.loads(row["metadata_json"])
    chat_id = str(row["id"])
    chat["events"] = [
        json.loads(event["payload_json"])
        for event in connection.execute(
            "SELECT payload_json FROM chat_events WHERE chat_id = ? ORDER BY position",
            (chat_id,),
        )
    ]
    branching = chat.get("branching")
    if _is_branch_graph(branching):
        if _has_embedded_nodes(branching):
            branching, off_path = _migrate_legacy_branching(connection, chat_id, chat, chat["events"])
        else:
            off_path = _off_path_events(connection, chat_id)
        if branch_refs:
            chat["branching"] = _reference_branching(branching, off_path)
        else:
            by_id = {**off_path, **{str(event.get("id", "")): event for event in chat["events"]}}
            chat["branching"] = _embed_branching(branching, by_id)
    tags = [item["tag"] for item in connection.execute(
        "SELECT tag FROM chat_tags WHERE chat_id = ? ORDER BY score DESC, tag",
        (chat_id,),
    )]
    if tags:
        chat["tags"] = tags
    else:
        chat.pop("tags", None)
    return chat


def _chat_file(chat_id: str) -> Path:
    """Return the path to the chat.json for a chat."""
    return cfg.chat_dir(chat_id) / "chat.json"


def _atomic_write(path: Path, data: dict):
    """Write JSON atomically via a temp file to avoid partial writes."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, default=str), encoding="utf-8")
    os.replace(tmp, path)


def load_chat_metadata(chat_id: str) -> Optional[dict]:
    """Load only canonical chat metadata, never transcript events.

    Hot routing paths (notably Design asset proxying) need a few metadata fields
    and must not deserialize the entire conversation for every HTTP request.
    """
    with _DB_LOCK, _database() as connection:
        row = connection.execute("SELECT metadata_json FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if row is not None:
            return json.loads(row["metadata_json"])
    path = _chat_file(chat_id)
    if not path.exists():
        return None
    try:
        legacy = json.loads(path.read_text(encoding="utf-8"))
        # Strip potentially enormous transcript material for the routing caller.
        return {key: value for key, value in legacy.items() if key != "events"}
    except (json.JSONDecodeError, OSError):
        return None


_SUMMARY_FIELDS = (
    "schemaVersion", "id", "title", "createdAt", "updatedAt",
    "enabledKits", "disabledTools", "folderId",
)


def _summary_fields(metadata: dict) -> dict:
    return {key: metadata[key] for key in _SUMMARY_FIELDS if key in metadata}


def _summary_from_metadata(metadata: dict, tags: list[str] | None = None) -> dict:
    """Return the lightweight sidebar projection for a chat."""
    summary = _summary_fields(metadata)
    summary.setdefault("schemaVersion", 2)
    summary["events"] = []
    summary["_summaryOnly"] = True
    if tags:
        summary["tags"] = tags
    return summary


def load_chat_summaries() -> list[dict]:
    """Load sidebar chat metadata without deserializing transcript history.

    Reads only the stored ``summary_json`` projection. Rows written before that
    column existed are backfilled once (their metadata parsed a single time).
    """
    # Preserve the legacy on-disk import behavior.  This path only does expensive
    # work for chats that have not yet been migrated into SQLite.
    if cfg.CHATS_DIR.exists():
        for entry in cfg.CHATS_DIR.iterdir():
            if entry.is_dir() and (entry / "chat.json").exists():
                with _DB_LOCK, _database() as connection:
                    exists = connection.execute(
                        "SELECT 1 FROM chats WHERE id = ?", (entry.name,)
                    ).fetchone()
                if exists is None:
                    load_chat(entry.name)

    with _DB_LOCK, _database() as connection:
        rows = connection.execute(
            "SELECT id, summary_json FROM chats ORDER BY updated_at DESC"
        ).fetchall()
        missing = [str(row["id"]) for row in rows if row["summary_json"] is None]
        backfilled: dict[str, dict] = {}
        for chat_id in missing:
            metadata = json.loads(connection.execute(
                "SELECT metadata_json FROM chats WHERE id = ?", (chat_id,)
            ).fetchone()["metadata_json"])
            backfilled[chat_id] = _summary_fields(metadata)
            connection.execute("UPDATE chats SET summary_json = ? WHERE id = ?",
                               (json.dumps(backfilled[chat_id], default=str), chat_id))
        tags_by_chat: dict[str, list[str]] = {}
        for tag_row in connection.execute(
            "SELECT chat_id, tag FROM chat_tags ORDER BY chat_id, score DESC, tag"
        ):
            tags_by_chat.setdefault(str(tag_row["chat_id"]), []).append(str(tag_row["tag"]))

    result: list[dict] = []
    for row in rows:
        chat_id = str(row["id"])
        summary = backfilled.get(chat_id) or json.loads(row["summary_json"])
        summary.setdefault("id", chat_id)
        result.append(_summary_from_metadata(summary, tags_by_chat.get(chat_id)))
    return result


def load_chat(chat_id: str, *, branch_refs: bool = False) -> Optional[dict]:
    """Load a single chat by ID. Returns None if not found.

    ``branch_refs`` returns compact reference-form branching (nodes carry ids;
    off-path payloads listed once) for renderers that understand it.
    """
    with _DB_LOCK, _database() as connection:
        row = connection.execute("SELECT id, metadata_json FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if row is not None:
            return _row_to_chat(connection, row, branch_refs=branch_refs)
    path = _chat_file(chat_id)
    if not path.exists():
        return None
    try:
        legacy = json.loads(path.read_text(encoding="utf-8"))
        save_chat(legacy)
        return legacy
    except (json.JSONDecodeError, OSError):
        return None


def load_all_chats() -> list[dict]:
    """
    Load all chats from disk, sorted by updatedAt descending.
    Skips any chat dirs that don't have a chat.json or have corrupt JSON.
    """
    if cfg.CHATS_DIR.exists():
        for entry in cfg.CHATS_DIR.iterdir():
            if entry.is_dir() and (entry / "chat.json").exists():
                load_chat(entry.name)
    with _DB_LOCK, _database() as connection:
        rows = connection.execute("SELECT id, metadata_json FROM chats ORDER BY updated_at DESC").fetchall()
        return [_row_to_chat(connection, row) for row in rows]


def delete_chat(chat_id: str) -> bool:
    """
    Remove the chat.json for a chat. The workspace/attachments/git dirs
    are left intact (workspace.delete_workspace handles those separately).
    Returns True if the file existed and was deleted.
    """
    with _DB_LOCK, _database() as connection:
        keys = [row[0] for row in connection.execute("SELECT key FROM fts_rowids WHERE chat_id = ?", (chat_id,))]
        connection.executemany("DELETE FROM chat_search WHERE rowid = ?", [(key,) for key in keys])
        connection.executemany("DELETE FROM transcript_search WHERE rowid = ?", [(key,) for key in keys])
        connection.execute("DELETE FROM fts_rowids WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM chat_tag_search WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM transcript_event_meta WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM chat_current_events WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM branch_event_map WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM branch_events WHERE chat_id = ?", (chat_id,))
        deleted = connection.execute("DELETE FROM chats WHERE id = ?", (chat_id,)).rowcount > 0
    path = _chat_file(chat_id)
    if path.exists():
        path.unlink()
        deleted = True
    return deleted


def chat_exists(chat_id: str) -> bool:
    with _DB_LOCK, _database() as connection:
        if connection.execute("SELECT 1 FROM chats WHERE id = ?", (chat_id,)).fetchone():
            return True
    return _chat_file(chat_id).exists() and load_chat(chat_id) is not None


# Monotonic version of the derived topic projection. Clients poll with
# ``since_version`` (cheap "unchanged" answers) and are pushed a notice when it
# advances, instead of re-downloading every tag every few seconds.
_TOPIC_VERSION = 0
_TOPIC_LISTENERS: list = []


def topic_version() -> int:
    return _TOPIC_VERSION


def add_topic_listener(callback) -> None:
    if callback not in _TOPIC_LISTENERS:
        _TOPIC_LISTENERS.append(callback)


def _topics_changed() -> None:
    global _TOPIC_VERSION
    _TOPIC_VERSION += 1
    for callback in list(_TOPIC_LISTENERS):
        try:
            callback(_TOPIC_VERSION)
        except Exception:
            pass


def replace_topic_tags(
    assignments: dict[str, list[tuple[str, float]]],
    *,
    chat_ids: set[str] | None = None,
) -> int:
    """Atomically replace selected conversations' derived topic projections."""
    try:
        return _replace_topic_tags(assignments, chat_ids=chat_ids)
    finally:
        _topics_changed()


def _replace_topic_tags(
    assignments: dict[str, list[tuple[str, float]]],
    *,
    chat_ids: set[str] | None = None,
) -> int:
    with _DB_LOCK, _database() as connection:
        if chat_ids is None:
            connection.execute("DELETE FROM chat_tags")
            connection.execute("DELETE FROM chat_tag_search")
        else:
            for chat_id in chat_ids:
                connection.execute("DELETE FROM chat_tags WHERE chat_id = ?", (chat_id,))
                connection.execute("DELETE FROM chat_tag_search WHERE chat_id = ?", (chat_id,))
        if chat_ids is None:
            existing = {row["id"] for row in connection.execute("SELECT id FROM chats")}
        else:
            existing = {
                chat_id for chat_id in chat_ids
                if connection.execute("SELECT 1 FROM chats WHERE id = ?", (chat_id,)).fetchone()
            }
        count = 0
        for chat_id, values in assignments.items():
            if chat_id not in existing or (chat_ids is not None and chat_id not in chat_ids):
                continue
            for tag, score in values:
                clean = str(tag).strip().lower()
                if not clean:
                    continue
                connection.execute(
                    "INSERT OR REPLACE INTO chat_tags(chat_id,tag,score) VALUES(?,?,?)",
                    (chat_id, clean, float(score)),
                )
                connection.execute(
                    "INSERT INTO chat_tag_search(chat_id,tag) VALUES(?,?)",
                    (chat_id, clean),
                )
                count += 1
        return count


def topic_tags() -> dict[str, list[str]]:
    """Return lightweight server-authoritative tag projections for live clients."""
    result: dict[str, list[str]] = {}
    with _DB_LOCK, _database() as connection:
        for row in connection.execute(
            "SELECT chat_id,tag FROM chat_tags ORDER BY chat_id,score DESC,tag"
        ):
            result.setdefault(row["chat_id"], []).append(row["tag"])
    return result


def _fts_expression(query: str) -> str:
    return '"' + str(query).replace('"', '""') + '"'


def _exact_occurrences(text: str, query: str) -> list[tuple[int, int, int]]:
    needle = query.strip().lower()
    if not needle:
        return []
    haystack = text.lower()
    result: list[tuple[int, int, int]] = []
    start_from = 0
    occurrence = 0
    while start_from <= len(haystack) - len(needle):
        start = haystack.find(needle, start_from)
        if start < 0:
            break
        result.append((start, start + len(needle), occurrence))
        occurrence += 1
        start_from = start + max(len(needle), 1)
    return result


def _direct_current_search_rows(connection: sqlite3.Connection, query: str) -> list[sqlite3.Row]:
    """Return the matched current-branch messages directly from FTS5.

    Universal search deliberately does no snippet generation, exact-offset scanning,
    corpus hydration, or second metadata search. One SQL query returns the matched
    message rows in the same conversation/order that the sidebar renders them.
    """
    clean = query.strip()
    if not clean:
        return []
    if len(clean) >= 3:
        return connection.execute(
            """
            SELECT transcript_search.chat_id,
                   transcript_search.event_id,
                   transcript_search.event_type,
                   transcript_search.content AS message,
                   m.timestamp,
                   c.position,
                   chats.updated_at
              FROM transcript_search
              JOIN chat_current_events AS c
                ON c.chat_id = transcript_search.chat_id
               AND c.event_id = transcript_search.event_id
              JOIN chats
                ON chats.id = transcript_search.chat_id
              LEFT JOIN transcript_event_meta AS m
                ON m.chat_id = transcript_search.chat_id
               AND m.event_id = transcript_search.event_id
             WHERE transcript_search MATCH ?
             ORDER BY chats.updated_at DESC, transcript_search.chat_id, c.position
            """,
            (_fts_expression(clean),),
        ).fetchall()

    # Trigram FTS cannot satisfy one/two-character queries. Keep the uncommon
    # fallback equally direct: current-branch rows only, ordered exactly the same.
    return connection.execute(
        """
        SELECT transcript_search.chat_id,
               transcript_search.event_id,
               transcript_search.event_type,
               transcript_search.content AS message,
               m.timestamp,
               c.position,
               chats.updated_at
          FROM transcript_search
          JOIN chat_current_events AS c
            ON c.chat_id = transcript_search.chat_id
           AND c.event_id = transcript_search.event_id
          JOIN chats
            ON chats.id = transcript_search.chat_id
          LEFT JOIN transcript_event_meta AS m
            ON m.chat_id = transcript_search.chat_id
           AND m.event_id = transcript_search.event_id
         WHERE lower(transcript_search.content) LIKE ?
         ORDER BY chats.updated_at DESC, transcript_search.chat_id, c.position
        """,
        (f"%{clean.lower()}%",),
    ).fetchall()


def _direct_branch_search_rows(connection: sqlite3.Connection, chat_id: str, query: str) -> list[sqlite3.Row]:
    """Return matched branch messages directly from FTS5 + the branch path map."""
    clean = query.strip()
    if not clean:
        return []
    if len(clean) >= 3:
        return connection.execute(
            """
            SELECT branch_event_map.branch_id,
                   transcript_search.event_id,
                   transcript_search.event_type,
                   transcript_search.content AS message,
                   m.timestamp,
                   branch_event_map.position
              FROM branch_event_map
              JOIN transcript_search
                ON transcript_search.chat_id = branch_event_map.chat_id
               AND transcript_search.event_id = branch_event_map.event_id
              LEFT JOIN transcript_event_meta AS m
                ON m.chat_id = transcript_search.chat_id
               AND m.event_id = transcript_search.event_id
             WHERE branch_event_map.chat_id = ?
               AND transcript_search MATCH ?
             ORDER BY branch_event_map.branch_id, branch_event_map.position
            """,
            (chat_id, _fts_expression(clean)),
        ).fetchall()
    return connection.execute(
        """
        SELECT branch_event_map.branch_id,
               transcript_search.event_id,
               transcript_search.event_type,
               transcript_search.content AS message,
               m.timestamp,
               branch_event_map.position
          FROM branch_event_map
          JOIN transcript_search
            ON transcript_search.chat_id = branch_event_map.chat_id
           AND transcript_search.event_id = branch_event_map.event_id
          LEFT JOIN transcript_event_meta AS m
            ON m.chat_id = transcript_search.chat_id
           AND m.event_id = transcript_search.event_id
         WHERE branch_event_map.chat_id = ?
           AND lower(transcript_search.content) LIKE ?
         ORDER BY branch_event_map.branch_id, branch_event_map.position
        """,
        (chat_id, f"%{clean.lower()}%"),
    ).fetchall()


def _direct_hit(row: sqlite3.Row) -> dict:
    return {
        "event_id": row["event_id"],
        "event_type": row["event_type"],
        "message": row["message"] or "",
        "timestamp": row["timestamp"] or "",
    }


def search_current_transcripts(query: str) -> dict:
    """FTS5 -> matched message rows -> conversation groups. Nothing else."""
    clean = str(query).strip()
    if not clean:
        return {"chat_ids": [], "hits_by_chat": {}}
    with _DB_LOCK, _database() as connection:
        rows = _direct_current_search_rows(connection, clean)

    chat_ids: list[str] = []
    hits_by_chat: dict[str, list[dict]] = {}
    for row in rows:
        chat_id = row["chat_id"]
        if chat_id not in hits_by_chat:
            chat_ids.append(chat_id)
            hits_by_chat[chat_id] = []
        hits_by_chat[chat_id].append(_direct_hit(row))
    return {"chat_ids": chat_ids, "hits_by_chat": hits_by_chat}


def search_branches(chat_id: str, query: str) -> dict:
    """FTS5 -> matched branch message rows -> branch groups. Nothing else."""
    clean = str(query).strip()
    if not clean:
        return {"branch_ids": [], "hits_by_branch": {}}
    with _DB_LOCK, _database() as connection:
        rows = _direct_branch_search_rows(connection, chat_id, clean)
        chat_row = connection.execute("SELECT metadata_json FROM chats WHERE id = ?", (chat_id,)).fetchone()

    metadata = json.loads(chat_row["metadata_json"]) if chat_row else {}
    branch_meta = ((metadata.get("branching") or {}).get("branches") or []) if isinstance(metadata, dict) else []
    created = {str(branch.get("id")): str(branch.get("createdAt", "")) for branch in branch_meta if isinstance(branch, dict)}
    hits_by_branch: dict[str, list[dict]] = {}
    for row in rows:
        hits_by_branch.setdefault(row["branch_id"], []).append(_direct_hit(row))
    branch_ids = sorted(hits_by_branch, key=lambda branch_id: created.get(branch_id, ""), reverse=True)
    return {"branch_ids": branch_ids, "hits_by_branch": hits_by_branch}


def search_chat_ids(query: str) -> list[str]:
    """Search conversation titles and derived tags through canonical SQLite."""
    words = [part for part in str(query).lower().split() if part]
    with _DB_LOCK, _database() as connection:
        rows = connection.execute("""
            SELECT c.id, json_extract(c.metadata_json, '$.title') AS title,
                   COALESCE(GROUP_CONCAT(t.tag, ' '), '') AS tags
              FROM chats AS c
              LEFT JOIN chat_tags AS t ON t.chat_id = c.id
             GROUP BY c.id
             ORDER BY c.updated_at DESC
        """).fetchall()
    return [
        row["id"] for row in rows
        if all(word in f"{row['title'] or ''} {row['tags']}".lower() for word in words)
    ]
