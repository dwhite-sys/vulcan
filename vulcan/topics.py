"""Background conversation tagging from already-indexed message embeddings.

This module never embeds, summarizes, prompts, or calls an inference provider.
Messages may belong to different topic clusters, so one chat can inherit several
independently discovered, human-readable tags.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
from collections import Counter, defaultdict

from vulcan import chats, recall


logger = logging.getLogger("vulcan.topics")
_SIGNAL = threading.Event()
_THREAD: threading.Thread | None = None
_LOCK = threading.RLock()
_DIRTY_CHATS: set[str] = set()
_FULL_REBUILD = False
_MAX_MESSAGES_PER_CHAT = 128
_MAX_MESSAGES = 6000
_MAX_TAGS_PER_CHAT = 10
_DEBOUNCE_SECONDS = 0.75
_GENERIC = {
    "about", "actually", "answer", "assistant", "chat", "conversation", "does",
    "don", "going", "just", "know", "like", "need", "question", "really", "said",
    "thing", "things", "think", "time", "use", "user", "using", "want", "work",
}


def _records(chat_id: str | None = None) -> list[dict]:
    """Read existing current vectors, optionally from one changed conversation."""
    import numpy as np

    selection = "AND e.chat_id = ?" if chat_id is not None else ""
    parameters = ((chat_id,) if chat_id is not None else ()) + (_MAX_MESSAGES_PER_CHAT, _MAX_MESSAGES)
    with chats._DB_LOCK, chats._database() as source:
        canonical = {
            (row["chat_id"], row["event_id"]): row
            for row in source.execute(f"""
                WITH recent AS (
                    SELECT e.chat_id,e.event_id,e.position,c.updated_at,
                           json_extract(c.metadata_json, '$.title') AS title,
                           ROW_NUMBER() OVER (
                               PARTITION BY e.chat_id ORDER BY e.position DESC
                           ) AS in_chat
                      FROM chat_events AS e
                      JOIN chats AS c ON c.id = e.chat_id
                     WHERE (e.event_type = 'user_message'
                        OR (e.event_type = 'assistant_text'
                            AND COALESCE(json_extract(e.payload_json, '$.status'), 'complete') = 'complete'))
                       {selection}
                )
                SELECT r.chat_id,r.event_id,r.position,r.title,s.content,s.role
                  FROM recent AS r
                  JOIN chat_search AS s
                    ON s.chat_id = r.chat_id AND s.event_id = r.event_id
                 WHERE r.in_chat <= ? AND s.content != ''
                 ORDER BY r.updated_at DESC,r.position DESC
                 LIMIT ?
            """, parameters)
        }

    with recall._vector_database() as database:
        stored = {}
        keys = list(canonical)
        for offset in range(0, len(keys), 200):
            batch = keys[offset:offset + 200]
            conditions = " OR ".join("(chat_id = ? AND event_id = ?)" for _ in batch)
            parameters = [part for key in batch for part in key]
            for row in database.execute(
                "SELECT chat_id,event_id,content_hash,dimensions,vector "
                f"FROM message_vectors WHERE model = ? AND ({conditions})",
                (recall._MODEL_NAME, *parameters),
            ):
                stored[(row["chat_id"], row["event_id"])] = row

    records = []
    per_chat: Counter[str] = Counter()
    dimensions = None
    for key, row in canonical.items():
        vector = stored.get(key)
        if vector is None or per_chat[row["chat_id"]] >= _MAX_MESSAGES_PER_CHAT:
            continue
        if vector["content_hash"] != hashlib.sha256(row["content"].encode("utf-8")).hexdigest():
            continue
        size = int(vector["dimensions"])
        if dimensions is None:
            dimensions = size
        if size != dimensions:
            continue
        values = np.frombuffer(vector["vector"], dtype=np.float32)
        if len(values) != size:
            continue
        records.append({
            "chat_id": row["chat_id"],
            "event_id": row["event_id"],
            "content": row["content"],
            "title": row["title"] or "",
            "vector": values,
        })
        per_chat[row["chat_id"]] += 1
        if len(records) >= _MAX_MESSAGES:
            break
    return records


def _choose_tags(scores, vocabulary, *, limit: int = 4) -> list[tuple[str, float]]:
    """Select readable, nonredundant observed phrases; never synthesize a summary."""
    import numpy as np

    chosen = []
    for index in np.argsort(scores)[::-1]:
        score = float(scores[index])
        if score <= 0:
            break
        phrase = str(vocabulary[index]).strip().lower()
        words = phrase.split()
        if not words or len(phrase) > 48 or all(word in _GENERIC for word in words):
            continue
        if any(phrase in previous or previous in phrase for previous, _ in chosen):
            continue
        chosen.append((phrase, score))
        if len(chosen) >= limit:
            break
    return chosen


def rebuild(chat_id: str | None = None) -> dict:
    """Refresh one changed chat, or explicitly rebuild all chats when requested."""
    import numpy as np
    from sklearn.cluster import HDBSCAN
    from sklearn.decomposition import PCA
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.preprocessing import normalize

    records = _records(chat_id) if chat_id is not None else _records()
    affected = {chat_id} if chat_id is not None else None
    if not records:
        chats.replace_topic_tags({}, chat_ids=affected)
        return {"messages": 0, "clusters": 0, "chats": 0, "tags": 0}

    matrix = normalize(np.vstack([row["vector"] for row in records])).astype(np.float32)
    if len(matrix) >= 4:
        dimensions = min(8, matrix.shape[1], len(matrix) - 1)
        reduced = normalize(PCA(n_components=dimensions, random_state=0).fit_transform(matrix))
        estimator = HDBSCAN(
            min_cluster_size=min(3, len(matrix)),
            min_samples=2,
            cluster_selection_method="leaf",
            n_jobs=1,
            copy=False,
        )
        labels = estimator.fit_predict(reduced)
    else:
        labels = np.full(len(matrix), -1, dtype=np.int32)

    # Titles help name an observed topic but never affect its semantic cluster.
    documents = [f"{row['title']} {row['title']} {row['content'][:1200]}" for row in records]
    vectorizer = TfidfVectorizer(
        stop_words="english",
        ngram_range=(1, 2),
        max_features=12000,
        sublinear_tf=True,
        token_pattern=r"(?u)\b[\w][\w-]+\b",
    )
    try:
        lexical = vectorizer.fit_transform(documents)
    except ValueError:
        chats.replace_topic_tags({}, chat_ids=affected)
        return {"messages": len(records), "clusters": 0, "chats": 0, "tags": 0}
    vocabulary = vectorizer.get_feature_names_out()

    cluster_tags = {}
    for label in sorted(set(labels) - {-1}):
        indices = np.flatnonzero(labels == label)
        scores = np.asarray(lexical[indices].mean(axis=0)).ravel()
        cluster_tags[int(label)] = _choose_tags(scores, vocabulary)

    observed_words: dict[str, set[str]] = defaultdict(set)
    for row in records:
        observed_words[row["chat_id"]].update(
            re.findall(r"[\w][\w-]+", f"{row['title']} {row['content']}".lower())
        )

    assignments: dict[str, Counter[str]] = defaultdict(Counter)
    for index, row in enumerate(records):
        label = int(labels[index])
        values = [
            (tag, score) for tag, score in cluster_tags.get(label, [])
            if any(word in observed_words[row["chat_id"]] for word in tag.split())
        ]
        if not values:
            # New topics and HDBSCAN noise remain searchable immediately.
            scores = np.asarray(lexical[index].todense()).ravel()
            values = _choose_tags(scores, vocabulary, limit=3)
        for tag, score in values:
            assignments[row["chat_id"]][tag] += score

    ranked = {
        chat_id: sorted(values.items(), key=lambda pair: (-pair[1], pair[0]))[:_MAX_TAGS_PER_CHAT]
        for chat_id, values in assignments.items()
    }
    count = chats.replace_topic_tags(ranked, chat_ids=affected)
    return {
        "messages": len(records),
        "clusters": len(cluster_tags),
        "chats": len(ranked),
        "tags": count,
    }


def _worker() -> None:
    global _FULL_REBUILD
    while True:
        _SIGNAL.wait()
        while True:
            _SIGNAL.clear()
            if not _SIGNAL.wait(timeout=_DEBOUNCE_SECONDS):
                break
        try:
            with _LOCK:
                rebuild_everything = _FULL_REBUILD
                _FULL_REBUILD = False
                changed = tuple(_DIRTY_CHATS)
                _DIRTY_CHATS.clear()
            if rebuild_everything:
                result = rebuild()
                logger.debug("Explicitly rebuilt all chat topic tags: %s", result)
            else:
                for chat_id in changed:
                    result = rebuild(chat_id)
                    logger.debug("Refreshed topic tags for chat %s: %s", chat_id, result)
        except Exception:
            logger.exception("Could not refresh server-owned chat topic tags")


def schedule_rebuild(chat_id: str | None = None) -> None:
    """Debounce changed conversations; an explicit None requests a full rebuild."""
    global _THREAD, _FULL_REBUILD
    with _LOCK:
        if chat_id is None:
            _FULL_REBUILD = True
        else:
            _DIRTY_CHATS.add(chat_id)
        if _THREAD is None or not _THREAD.is_alive():
            _THREAD = threading.Thread(target=_worker, name="vulcan-chat-topics", daemon=True)
            _THREAD.start()
        _SIGNAL.set()
