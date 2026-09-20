"""
vulcan/chats.py — Server-side chat persistence.

Chats and their ordered, lossless event records live in ~/.vulcan/chats.sqlite3.
Legacy ~/.vulcan/chats/<chat-uuid>/chat.json snapshots are imported on demand.
The public API continues to return the exact existing client-side Chat shape.
"""

import json
import os
import re
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from vulcan import config as cfg


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


def _branch_paths(metadata: dict, current_events: list[dict]) -> tuple[dict[str, list[str]], str | None, dict[str, dict]]:
    """Return derived branch paths without duplicating canonical event payloads."""
    branching = metadata.get("branching") if isinstance(metadata, dict) else None
    if not isinstance(branching, dict):
        return {}, None, {str(event.get("id")): event for event in current_events if event.get("id")}

    nodes_raw = branching.get("nodes") or []
    branches_raw = branching.get("branches") or []
    nodes: dict[str, tuple[dict, str | None]] = {}
    for item in nodes_raw:
        if not isinstance(item, dict) or not isinstance(item.get("event"), dict):
            continue
        event = item["event"]
        event_id = str(event.get("id", ""))
        if event_id:
            parent_id = item.get("parentId")
            nodes[event_id] = (event, str(parent_id) if parent_id else None)
    # Streaming/current path can contain newer events than persisted branch nodes.
    previous: str | None = None
    for event in current_events:
        event_id = str(event.get("id", ""))
        if not event_id:
            continue
        old = nodes.get(event_id)
        nodes[event_id] = (event, old[1] if old else previous)
        previous = event_id

    paths: dict[str, list[str]] = {}
    for branch in branches_raw:
        if not isinstance(branch, dict):
            continue
        branch_id = str(branch.get("id", ""))
        if not branch_id:
            continue
        cursor = branch.get("headEventId")
        cursor = str(cursor) if cursor else None
        rev: list[str] = []
        seen: set[str] = set()
        while cursor and cursor not in seen:
            seen.add(cursor)
            node = nodes.get(cursor)
            if not node:
                break
            rev.append(cursor)
            cursor = node[1]
        paths[branch_id] = list(reversed(rev))

    return paths, str(branching.get("currentBranchId")) if branching.get("currentBranchId") else None, {event_id: pair[0] for event_id, pair in nodes.items()}


def _reindex_chat_search(connection: sqlite3.Connection, chat_id: str, metadata: dict, events: list[dict]) -> None:
    """Refresh derived FTS/current-branch/branch-path projections for one chat."""
    connection.execute("DELETE FROM transcript_search WHERE chat_id = ?", (chat_id,))
    connection.execute("DELETE FROM transcript_event_meta WHERE chat_id = ?", (chat_id,))
    connection.execute("DELETE FROM chat_current_events WHERE chat_id = ?", (chat_id,))
    connection.execute("DELETE FROM branch_event_map WHERE chat_id = ?", (chat_id,))

    branch_paths, current_branch_id, canonical_events = _branch_paths(metadata, events)
    # Index each canonical event once. Shared ancestry is represented by branch_event_map.
    for event_id, event in canonical_events.items():
        text = transcript_event_search_text(event).strip()
        if not text:
            continue
        connection.execute(
            "INSERT INTO transcript_search(chat_id,event_id,event_type,content) VALUES(?,?,?,?)",
            (chat_id, event_id, str(event.get("type", "")), text),
        )
        connection.execute(
            "INSERT OR REPLACE INTO transcript_event_meta(chat_id,event_id,timestamp) VALUES(?,?,?)",
            (chat_id, event_id, str(event.get("timestamp", ""))),
        )

    # `events` is always the current live branch projection and therefore defines
    # normal universal chat search even when historical branches contain matches.
    for position, event in enumerate(events):
        event_id = str(event.get("id", ""))
        if event_id and transcript_event_search_text(event).strip():
            connection.execute(
                "INSERT INTO chat_current_events(chat_id,event_id,position) VALUES(?,?,?)",
                (chat_id, event_id, position),
            )

    if branch_paths:
        for branch_id, event_ids in branch_paths.items():
            for position, event_id in enumerate(event_ids):
                if event_id in canonical_events and transcript_event_search_text(canonical_events[event_id]).strip():
                    connection.execute(
                        "INSERT INTO branch_event_map(chat_id,branch_id,event_id,position) VALUES(?,?,?,?)",
                        (chat_id, branch_id, event_id, position),
                    )
    elif current_branch_id:
        # Defensive fallback for malformed branch metadata.
        for position, event in enumerate(events):
            event_id = str(event.get("id", ""))
            if event_id and transcript_event_search_text(event).strip():
                connection.execute(
                    "INSERT INTO branch_event_map(chat_id,branch_id,event_id,position) VALUES(?,?,?,?)",
                    (chat_id, current_branch_id, event_id, position),
                )


def _database() -> sqlite3.Connection:
    """Return the canonical chat/event database, creating it lazily."""
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(cfg.CONFIG_DIR / "chats.sqlite3"), timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
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
    # Preserve the legacy semantic-recall/message FTS projection too. Older DBs
    # may have canonical chat_events but no chat_search rows yet.
    legacy_indexed = connection.execute("SELECT EXISTS(SELECT 1 FROM chat_search)").fetchone()[0]
    if not legacy_indexed:
        connection.execute("""
            INSERT INTO chat_search(chat_id,event_id,role,content)
            SELECT chat_id, event_id,
                   CASE event_type WHEN 'user_message' THEN 'user' ELSE 'assistant' END,
                   json_extract(payload_json, '$.content')
              FROM chat_events
             WHERE event_type IN ('user_message', 'assistant_text')
               AND COALESCE(json_extract(payload_json, '$.content'), '') != ''
        """)

    # Existing databases predate branch-aware transcript FTS. Build the derived
    # projection once; it remains fully rebuildable from canonical chat storage.
    indexed = connection.execute("SELECT EXISTS(SELECT 1 FROM transcript_search)").fetchone()[0]
    meta_indexed = connection.execute("SELECT EXISTS(SELECT 1 FROM transcript_event_meta)").fetchone()[0]
    if not indexed or not meta_indexed:
        for row in connection.execute("SELECT id, metadata_json FROM chats").fetchall():
            metadata = json.loads(row["metadata_json"])
            events = [json.loads(event["payload_json"]) for event in connection.execute(
                "SELECT payload_json FROM chat_events WHERE chat_id = ? ORDER BY position", (row["id"],)
            )]
            _reindex_chat_search(connection, row["id"], metadata, events)
    return connection


def _row_to_chat(connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
    chat = json.loads(row["metadata_json"])
    chat["events"] = [
        json.loads(event["payload_json"])
        for event in connection.execute(
            "SELECT payload_json FROM chat_events WHERE chat_id = ? ORDER BY position",
            (row["id"],),
        )
    ]
    tags = [item["tag"] for item in connection.execute(
        "SELECT tag FROM chat_tags WHERE chat_id = ? ORDER BY score DESC, tag",
        (row["id"],),
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




def _sync_branching_projection(chat: dict) -> None:
    """Merge the compatibility current-path projection into the parent-only branch event graph.

    Agent runs still consume ``chat["events"]`` as their visible linear history. Branching
    metadata stores the durable topology: each event is present once and points only to its
    parent. Keeping this merge inside canonical persistence means server-owned streaming
    checkpoints cannot leave the branch graph stale after a restart.
    """
    branching = chat.get("branching")
    events = chat.get("events")
    if not isinstance(branching, dict) or branching.get("version") != 1 or not isinstance(events, list):
        return
    nodes = branching.get("nodes")
    branches = branching.get("branches")
    current_branch_id = branching.get("currentBranchId")
    if not isinstance(nodes, list) or not isinstance(branches, list) or not current_branch_id:
        return

    by_id: dict[str, dict] = {}
    order: list[str] = []
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("event"), dict):
            continue
        event_id = str(node["event"].get("id", ""))
        if not event_id or event_id in by_id:
            continue
        by_id[event_id] = node
        order.append(event_id)

    parent_id = None
    for event in events:
        if not isinstance(event, dict):
            continue
        event_id = str(event.get("id", ""))
        if not event_id:
            continue
        existing = by_id.get(event_id)
        if existing is None:
            existing = {"event": event, "parentId": parent_id}
            by_id[event_id] = existing
            order.append(event_id)
        else:
            existing["event"] = event
        parent_id = event_id

    branching["nodes"] = [by_id[event_id] for event_id in order]
    for branch in branches:
        if isinstance(branch, dict) and branch.get("id") == current_branch_id:
            branch["headEventId"] = parent_id
            if chat.get("updatedAt") is not None:
                branch["updatedAt"] = chat.get("updatedAt")
            break


def save_chat(chat: dict) -> dict:
    """
    Persist a chat dict to disk. Creates the chat dir if needed.
    Returns the chat as saved.
    """
    chat_id = chat.get("id")
    if not chat_id:
        raise ValueError("Chat must have an id")
    _sync_branching_projection(chat)
    # Tags are derived server-owned projections, never client-authored metadata.
    metadata = {key: value for key, value in chat.items() if key not in ("events", "tags")}
    events = chat.get("events", [])
    if not isinstance(events, list):
        raise ValueError("Chat events must be an ordered list")
    with _DB_LOCK, _database() as connection:
        connection.execute(
            "INSERT INTO chats(id, metadata_json, created_at, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json, "
            "created_at=excluded.created_at, updated_at=excluded.updated_at",
            (chat_id, json.dumps(metadata, default=str), str(chat.get("createdAt", "")),
             str(chat.get("updatedAt", ""))),
        )
        # Position is authoritative. Replace rows transactionally so edits and retry
        # truncation cannot leave stale events or accidentally reorder them.
        connection.execute("DELETE FROM chat_events WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM chat_search WHERE chat_id = ?", (chat_id,))
        for position, event in enumerate(events):
            event_id = str(event.get("id", ""))
            if not event_id:
                raise ValueError("Every chat event must have an id")
            connection.execute(
                "INSERT INTO chat_events(chat_id,event_id,position,event_type,run_id,turn_id,timestamp,payload_json) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (chat_id, event_id, position, str(event.get("type", "")), event.get("runId"),
                 event.get("turnId"), str(event.get("timestamp", "")), json.dumps(event, default=str)),
            )
            event_type = event.get("type")
            content = searchable_message_content(event)
            if event_type in ("user_message", "assistant_text") and content:
                role = "user" if event_type == "user_message" else "assistant"
                connection.execute(
                    "INSERT INTO chat_search(chat_id,event_id,role,content) VALUES(?,?,?,?)",
                    (chat_id, event_id, role, content),
                )
        _reindex_chat_search(connection, chat_id, metadata, events)
    # The transaction is committed before background ONNX indexing can inspect
    # it. Streaming assistant fragments are deliberately ignored by the queue.
    from vulcan import recall
    recall.queue_completed_messages(str(chat_id), events)
    return chat


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


def _summary_from_metadata(metadata: dict, tags: list[str] | None = None) -> dict:
    """Return the lightweight sidebar projection for a chat.

    Chat metadata can itself become very large because the branch graph contains
    canonical event payloads.  The sidebar only needs identity/ordering and a
    handful of small configuration fields; transcript/branch/design state is
    hydrated lazily when the chat is actually selected.
    """
    allowed = {
        "schemaVersion", "id", "title", "createdAt", "updatedAt",
        "enabledKits", "disabledTools", "folderId",
    }
    summary = {key: value for key, value in metadata.items() if key in allowed}
    summary.setdefault("schemaVersion", 2)
    summary["events"] = []
    summary["_summaryOnly"] = True
    if tags:
        summary["tags"] = tags
    return summary


def load_chat_summaries() -> list[dict]:
    """Load sidebar chat metadata without deserializing transcript history.

    This is intentionally a separate API from ``load_all_chats`` so older
    clients keep their existing full-list contract.  A large Vulcan database can
    contain tens of MiB of events and branch payloads; sending all of that at
    startup blocks the encrypted General WS before the user has selected a chat.
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
            "SELECT id, metadata_json FROM chats ORDER BY updated_at DESC"
        ).fetchall()
        tags_by_chat: dict[str, list[str]] = {}
        for tag_row in connection.execute(
            "SELECT chat_id, tag FROM chat_tags ORDER BY chat_id, score DESC, tag"
        ):
            tags_by_chat.setdefault(str(tag_row["chat_id"]), []).append(str(tag_row["tag"]))

    result: list[dict] = []
    for row in rows:
        metadata = json.loads(row["metadata_json"])
        metadata.setdefault("id", str(row["id"]))
        result.append(_summary_from_metadata(metadata, tags_by_chat.get(str(row["id"]))))
    return result


def load_chat(chat_id: str) -> Optional[dict]:
    """Load a single chat by ID. Returns None if not found."""
    with _DB_LOCK, _database() as connection:
        row = connection.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if row is not None:
            return _row_to_chat(connection, row)
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
        rows = connection.execute("SELECT * FROM chats ORDER BY updated_at DESC").fetchall()
        return [_row_to_chat(connection, row) for row in rows]


def delete_chat(chat_id: str) -> bool:
    """
    Remove the chat.json for a chat. The workspace/attachments/git dirs
    are left intact (workspace.delete_workspace handles those separately).
    Returns True if the file existed and was deleted.
    """
    with _DB_LOCK, _database() as connection:
        connection.execute("DELETE FROM chat_search WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM chat_tag_search WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM transcript_search WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM transcript_event_meta WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM chat_current_events WHERE chat_id = ?", (chat_id,))
        connection.execute("DELETE FROM branch_event_map WHERE chat_id = ?", (chat_id,))
        deleted = connection.execute("DELETE FROM chats WHERE id = ?", (chat_id,)).rowcount > 0
    path = _chat_file(chat_id)
    if path.exists():
        path.unlink()
        deleted = True
    return deleted


def chat_exists(chat_id: str) -> bool:
    return load_chat(chat_id) is not None


def replace_topic_tags(
    assignments: dict[str, list[tuple[str, float]]],
    *,
    chat_ids: set[str] | None = None,
) -> int:
    """Atomically replace selected conversations' derived topic projections."""
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
