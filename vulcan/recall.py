"""Server-owned lexical and message-semantic recall over canonical chats."""

from __future__ import annotations

import hashlib
import logging
import math
import os
import queue
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any

from vulcan import chats, config as cfg

logger = logging.getLogger("vulcan.recall")
WORD = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")
STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it",
    "of", "on", "or", "our", "that", "the", "this", "to", "was", "we", "what", "when", "which",
    "with", "you", "your",
}
_BANK = None
_BANK_PATH = None
_BANK_LOCK = threading.RLock()
_EMBEDDER = None
_EMBEDDER_DIMENSIONS: int | None = None
_EMBEDDER_LOCK = threading.RLock()
_PROVISION_LOCK = threading.RLock()
_INDEX_LOCK = threading.RLock()
_INDEX_QUEUE: queue.Queue[tuple[str, str, str, str]] = queue.Queue()
_INDEX_PENDING: dict[tuple[str, str], str] = {}
_INDEX_KNOWN: dict[tuple[str, str], str] = {}
_INDEX_THREAD: threading.Thread | None = None
_INDEXING_ACTIVE = False
_MODEL_NAME = "BAAI/bge-small-en-v1.5"


def _configured_bank() -> Path | None:
    configured = cfg.load().get("recall", {}).get("lexical_bank_path")
    candidates = [
        os.environ.get("VULCAN_SEMANTIC_BANK"),
        configured,
        cfg.CONFIG_DIR / "semantic_bank",
        Path.home() / "Documents" / "recall_tool_testing" / "semantic_bank",
        Path.home() / "semantic_bank",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if (path / "words.txt").is_file() and (path / "vectors.npy").is_file():
            return path
    return None


def lexical_bank():
    """Memory-map the external 247k-word bank only when needed."""
    global _BANK, _BANK_PATH
    path = _configured_bank()
    if path is None:
        return None
    with _BANK_LOCK:
        if _BANK is None or _BANK_PATH != path:
            from vulcan.semantic_bank import SemanticBank
            _BANK = SemanticBank(path)
            _BANK_PATH = path
    return _BANK


def _words(text: str) -> list[str]:
    return [word.lower() for word in WORD.findall(text) if len(word) > 1 and word.lower() not in STOP_WORDS]


def _seed_groups(query: str, supplied: list[list[str]] | None) -> list[list[str]]:
    groups = supplied if isinstance(supplied, list) and supplied else [_words(query)]
    normalized = []
    for group in groups[:8]:
        if not isinstance(group, list):
            continue
        words = []
        for item in group:
            words.extend(_words(str(item)))
        words = list(dict.fromkeys(words))[:8]
        if words:
            normalized.append(words)
    return normalized


def _expand(groups: list[list[str]]) -> list[list[str]]:
    bank = lexical_bank()
    if bank is None:
        return groups
    result = []
    for group in groups:
        known = [word for word in group if bank.has_word(word)]
        expanded = list(group)
        if known:
            try:
                category = bank.expand_category(
                    known,
                    generations=2,
                    neighbors_per_word=24,
                    max_additions_per_generation=8,
                    batched=True,
                )
                expanded.extend(word for word in category.active_words if word not in expanded)
            except Exception:
                logger.warning("Lexical expansion failed; continuing with exact seed words", exc_info=True)
        result.append(expanded[:24])
    return result


def _record(row: sqlite3.Row, score: float, *, matched: list[str] | None = None) -> dict[str, Any]:
    result = {
        "chat_id": row["chat_id"],
        "chat_title": row["title"],
        "event_id": row["event_id"],
        "role": row["role"],
        "timestamp": row["timestamp"],
        "content": row["content"],
        "score": round(float(score), 6),
    }
    if matched is not None:
        result["matched_words"] = matched
    return result


def _scope_filter(scope: str, current_chat_id: str | None) -> tuple[str, tuple]:
    if scope == "previous":
        return "(? IS NULL OR s.chat_id != ?)", (current_chat_id, current_chat_id)
    if scope == "current":
        if not current_chat_id:
            raise ValueError("Current-conversation recall requires an active conversation")
        # The latest user event begins the active request. Its position also
        # excludes every response/tool event produced by the current run.
        return (
            "s.chat_id = ? AND e.position < COALESCE("
            "(SELECT MAX(position) FROM chat_events "
            "WHERE chat_id = ? AND event_type = 'user_message'), 0)",
            (current_chat_id, current_chat_id),
        )
    raise ValueError("recall scope must be previous or current")


def lexical_search(query: str, groups: list[list[str]] | None, limit: int,
                   current_chat_id: str | None, scope: str = "previous") -> dict:
    if len(_words(query)) < 3:
        raise ValueError(
            "Lexical recall requires at least three meaningful query words. "
            "Add more specific terms or use semantic mode."
        )
    seed_groups = _seed_groups(query, groups)
    if not seed_groups:
        return {"mode": "lexical", "results": [], "keyword_seed_groups": [], "expanded_terms": []}
    expanded = _expand(seed_groups)
    all_words = list(dict.fromkeys(word for group in expanded for word in group))[:100]
    expression = " OR ".join('"' + word.replace('"', '""') + '"' for word in all_words)
    scope_sql, scope_arguments = _scope_filter(scope, current_chat_id)
    sql = f"""
        SELECT s.chat_id, s.event_id, s.role, s.content,
               json_extract(c.metadata_json, '$.title') AS title,
               e.timestamp AS timestamp,
               bm25(chat_search) AS rank
          FROM chat_search AS s
          JOIN chats AS c ON c.id = s.chat_id
          JOIN chat_events AS e ON e.chat_id = s.chat_id AND e.event_id = s.event_id
         WHERE chat_search MATCH ? AND {scope_sql}
         ORDER BY rank LIMIT ?
    """
    with chats._DB_LOCK, chats._database() as connection:
        rows = connection.execute(sql, (expression, *scope_arguments, max(limit * 15, 80))).fetchall()
    scored = []
    original = set(word for group in seed_groups for word in group)
    for row in rows:
        tokens = set(_words(row["content"]))
        matches = [word for word in all_words if word in tokens]
        covered = sum(any(word in tokens for word in group) for group in expanded)
        exact = len(tokens & original)
        score = covered * 5.0 + exact * 3.0 + min(len(matches), 12) * 0.3 - float(row["rank"]) * 0.05
        scored.append(_record(row, score, matched=matches[:12]))
    scored.sort(key=lambda item: (-item["score"], item["timestamp"] or ""))
    return {
        "mode": "lexical",
        "scope": scope,
        "keyword_seed_groups": seed_groups,
        "expanded_terms": expanded,
        "bank_available": lexical_bank() is not None,
        "results": scored[:limit],
    }


def _vector_database() -> sqlite3.Connection:
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(cfg.CONFIG_DIR / "recall_vectors.sqlite3"), timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS message_vectors (
            chat_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            model TEXT NOT NULL,
            dimensions INTEGER NOT NULL,
            vector BLOB NOT NULL,
            PRIMARY KEY(chat_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS message_vectors_chat ON message_vectors(chat_id);
    """)
    return connection


def embedder():
    global _EMBEDDER
    with _EMBEDDER_LOCK:
        if _EMBEDDER is None:
            try:
                from fastembed import TextEmbedding
            except ImportError as exc:
                raise RuntimeError(
                    "Semantic recall requires fastembed. Install Vulcan's Python dependencies or run "
                    "`pip install fastembed`. Lexical recall remains available."
                ) from exc
            cache = cfg.CONFIG_DIR / "models"
            cache.mkdir(parents=True, exist_ok=True)
            _EMBEDDER = TextEmbedding(model_name="BAAI/bge-small-en-v1.5", cache_dir=str(cache))
    return _EMBEDDER


def configure_bank(path: str | Path) -> Path:
    directory = Path(path).expanduser().resolve()
    config = cfg.load()
    config.setdefault("recall", {})["lexical_bank_path"] = str(directory)
    cfg.save(config)
    return directory


def build_lexical_bank(path: str | Path | None = None, *, force: bool = False) -> dict:
    """Download spaCy/model if needed and build a portable normalized bank."""
    from vulcan.semantic_bank import build_bank
    directory = Path(path).expanduser() if path else (_configured_bank() or cfg.CONFIG_DIR / "semantic_bank")
    existing = (directory / "words.txt").is_file() and (directory / "vectors.npy").is_file()
    if not existing or force:
        build_bank(directory)
    directory = configure_bank(directory)
    return {"path": str(directory), "reused": existing and not force}


def download_semantic_model() -> dict:
    """Materialize and warm the ONNX-backed BGE-small encoder."""
    global _EMBEDDER_DIMENSIONS
    model = embedder()
    # One tiny embedding verifies model files, tokenizer, and ONNX runtime.
    vector = next(iter(model.embed(["Vulcan semantic recall"])))
    _EMBEDDER_DIMENSIONS = len(vector)
    return {"model": _MODEL_NAME, "cache": str(cfg.CONFIG_DIR / "models"),
            "dimensions": _EMBEDDER_DIMENSIONS}


def semantic_model_info() -> dict:
    """Return warmed encoder metadata without paying for another inference."""
    if _EMBEDDER_DIMENSIONS is None:
        return download_semantic_model()
    return {"model": _MODEL_NAME, "cache": str(cfg.CONFIG_DIR / "models"),
            "dimensions": _EMBEDDER_DIMENSIONS}


def provision_models(path: str | Path | None = None, *, force: bool = False) -> dict:
    """Prepare Vulcan's built-in recall assets, reusing existing local caches."""
    with _PROVISION_LOCK:
        semantic = download_semantic_model()
        lexical = build_lexical_bank(path, force=force)
        return {"semantic": semantic, "lexical": lexical}


def status() -> dict:
    bank = _configured_bank()
    model_cache = cfg.CONFIG_DIR / "models"
    vectors = cfg.CONFIG_DIR / "recall_vectors.sqlite3"
    return {
        "lexical_bank": str(bank) if bank else None,
        "lexical_ready": bank is not None,
        "semantic_cache": str(model_cache),
        "semantic_downloaded": model_cache.is_dir() and any(model_cache.iterdir()),
        "vector_database": str(vectors),
        "vector_database_exists": vectors.is_file(),
    }


def _normalize(vectors):
    import numpy as np
    array = np.asarray(vectors, dtype=np.float32)
    if array.ndim == 1:
        array = array.reshape(1, -1)
    norms = np.linalg.norm(array, axis=1, keepdims=True)
    np.divide(array, norms, out=array, where=norms != 0)
    return array


def index_message(chat_id: str, event_id: str, content: str) -> bool:
    """Index one current, complete message without touching other history."""
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    with chats._DB_LOCK, chats._database() as source:
        current = source.execute(
            "SELECT s.content, e.event_type, json_extract(e.payload_json, '$.status') AS status "
            "FROM chat_search AS s JOIN chat_events AS e "
            "ON e.chat_id = s.chat_id AND e.event_id = s.event_id "
            "WHERE s.chat_id = ? AND s.event_id = ?",
            (chat_id, event_id),
        ).fetchone()
    if current is None or current["content"] != content:
        return False
    if current["event_type"] == "assistant_text" and current["status"] not in (None, "complete"):
        return False

    with _vector_database() as database:
        existing = database.execute(
            "SELECT content_hash, model FROM message_vectors WHERE chat_id = ? AND event_id = ?",
            (chat_id, event_id),
        ).fetchone()
    if existing and existing["content_hash"] == digest and existing["model"] == _MODEL_NAME:
        return False

    vector = _normalize(list(embedder().embed([content])))[0]

    # A retry or edit can replace the message while ONNX inference is running.
    # Never let that obsolete generation re-enter searchable history.
    with chats._DB_LOCK, chats._database() as source:
        current = source.execute(
            "SELECT content FROM chat_search WHERE chat_id = ? AND event_id = ?",
            (chat_id, event_id),
        ).fetchone()
    if current is None or current["content"] != content:
        return False

    with _vector_database() as database:
        database.execute(
            "INSERT OR REPLACE INTO message_vectors(chat_id,event_id,content_hash,model,dimensions,vector) "
            "VALUES(?,?,?,?,?,?)",
            (chat_id, event_id, digest, _MODEL_NAME, len(vector), vector.tobytes()),
        )
    return True


def _index_worker():
    while True:
        chat_id, event_id, content, digest = _INDEX_QUEUE.get()
        key = (chat_id, event_id)
        try:
            with _INDEX_LOCK:
                if _INDEX_PENDING.get(key) != digest:
                    continue
            changed = index_message(chat_id, event_id, content)
            if changed:
                from vulcan import topics
                topics.schedule_rebuild(chat_id)
            with _INDEX_LOCK:
                _INDEX_KNOWN[key] = digest
        except Exception:
            logger.exception("Could not index completed chat message %s/%s", chat_id, event_id)
        finally:
            with _INDEX_LOCK:
                if _INDEX_PENDING.get(key) == digest:
                    _INDEX_PENDING.pop(key, None)
            _INDEX_QUEUE.task_done()


def start_message_indexing():
    """Start one daemon worker after server-owned recall assets are ready."""
    global _INDEX_THREAD, _INDEXING_ACTIVE
    with _INDEX_LOCK:
        _INDEXING_ACTIVE = True
        if _INDEX_THREAD is None or not _INDEX_THREAD.is_alive():
            _INDEX_THREAD = threading.Thread(
                target=_index_worker, name="vulcan-message-embeddings", daemon=True,
            )
            _INDEX_THREAD.start()


def queue_completed_messages(chat_id: str, events: list[dict]) -> int:
    """Queue finalized user/assistant messages once per content revision."""
    with _INDEX_LOCK:
        if not _INDEXING_ACTIVE:
            return 0
        queued = 0
        for event in events:
            event_type = event.get("type")
            if event_type not in ("user_message", "assistant_text"):
                continue
            if event_type == "assistant_text" and event.get("status") not in (None, "complete"):
                continue
            content = chats.searchable_message_content(event)
            event_id = str(event.get("id", ""))
            if not content or not event_id:
                continue
            key = (chat_id, event_id)
            digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
            if _INDEX_PENDING.get(key) == digest or _INDEX_KNOWN.get(key) == digest:
                continue
            _INDEX_PENDING[key] = digest
            _INDEX_QUEUE.put((chat_id, event_id, content, digest))
            queued += 1
        return queued


def semantic_search(query: str, limit: int, current_chat_id: str | None, scope: str = "previous") -> dict:
    """Return direct cosine nearest neighbors among BGE message embeddings."""
    import numpy as np
    scope_sql, scope_arguments = _scope_filter(scope, current_chat_id)
    with chats._DB_LOCK, chats._database() as source:
        records = source.execute(f"""
            SELECT s.chat_id, s.event_id, s.role, s.content,
                   json_extract(c.metadata_json, '$.title') AS title, e.timestamp AS timestamp
              FROM chat_search AS s
              JOIN chats AS c ON c.id = s.chat_id
              JOIN chat_events AS e ON e.chat_id = s.chat_id AND e.event_id = s.event_id
             WHERE {scope_sql}
               AND (e.event_type = 'user_message'
                    OR COALESCE(json_extract(e.payload_json, '$.status'), 'complete') = 'complete')
        """, scope_arguments).fetchall()
    with _vector_database() as vectors:
        existing = {
            (row["chat_id"], row["event_id"]): row
            for row in vectors.execute("SELECT * FROM message_vectors WHERE model = ?", (_MODEL_NAME,))
        }
        indexed = [
            row for row in records
            if (entry := existing.get((row["chat_id"], row["event_id"]))) is not None
            and entry["content_hash"] == hashlib.sha256(row["content"].encode("utf-8")).hexdigest()
        ]
        if not indexed:
            return {
                "mode": "semantic", "scope": scope, "model": _MODEL_NAME, "indexed_messages": 0,
                "pending_messages": len(records), "newly_indexed": 0, "results": [],
            }
        matrix = np.stack([
            np.frombuffer(existing[(row["chat_id"], row["event_id"])]["vector"], dtype=np.float32)
            for row in indexed
        ])
    query_vector = _normalize(list(embedder().embed([query])))[0]
    # Both sides are L2-normalized: dot product is cosine similarity. Semantic
    # recall intentionally does not expand terms, seed categories, or rerank.
    scores = matrix @ query_vector
    chosen = np.argsort(scores)[::-1][:limit]
    return {
        "mode": "semantic", "scope": scope, "model": _MODEL_NAME, "indexed_messages": len(indexed),
        "pending_messages": len(records) - len(indexed), "newly_indexed": 0,
        "results": [_record(indexed[int(position)], float(scores[int(position)])) for position in chosen],
    }


def search(query: str, *, mode: str = "lexical", keyword_seed_groups: list[list[str]] | None = None,
           limit: int = 8, current_chat_id: str | None = None, scope: str = "previous") -> dict:
    query = str(query).strip()
    if not query:
        raise ValueError("recall requires a non-empty query")
    if scope not in ("previous", "current"):
        raise ValueError("recall scope must be previous or current")
    limit = max(1, min(int(limit), 20))
    if mode == "lexical":
        return lexical_search(query, keyword_seed_groups, limit, current_chat_id, scope)
    if mode == "semantic":
        return semantic_search(query, limit, current_chat_id, scope)
    raise ValueError("recall mode must be lexical or semantic")
