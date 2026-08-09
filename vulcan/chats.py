"""
vulcan/chats.py — Server-side chat persistence.

Chats are stored as JSON files alongside their workspace data:
  ~/.vulcan/chats/<chat-uuid>/chat.json

This keeps chat history co-located with the workspace, attachments,
and git history for the same conversation — everything in one place.

The JSON format mirrors the client-side Chat type exactly so the client
can round-trip without any transformation.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from vulcan import config as cfg


def _chat_file(chat_id: str) -> Path:
    """Return the path to the chat.json for a chat."""
    return cfg.chat_dir(chat_id) / "chat.json"


def _atomic_write(path: Path, data: dict):
    """Write JSON atomically via a temp file to avoid partial writes."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, default=str), encoding="utf-8")
    os.replace(tmp, path)


def save_chat(chat: dict) -> dict:
    """
    Persist a chat dict to disk. Creates the chat dir if needed.
    Returns the chat as saved.
    """
    chat_id = chat.get("id")
    if not chat_id:
        raise ValueError("Chat must have an id")
    path = _chat_file(chat_id)
    _atomic_write(path, chat)
    return chat


def load_chat(chat_id: str) -> Optional[dict]:
    """Load a single chat by ID. Returns None if not found."""
    path = _chat_file(chat_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def load_all_chats() -> list[dict]:
    """
    Load all chats from disk, sorted by updatedAt descending.
    Skips any chat dirs that don't have a chat.json or have corrupt JSON.
    """
    chats = []
    if not cfg.CHATS_DIR.exists():
        return chats
    for entry in cfg.CHATS_DIR.iterdir():
        if not entry.is_dir():
            continue
        chat_file = entry / "chat.json"
        if not chat_file.exists():
            continue
        try:
            chat = json.loads(chat_file.read_text(encoding="utf-8"))
            chats.append(chat)
        except (json.JSONDecodeError, OSError):
            continue
    # Sort by updatedAt descending — most recent first
    chats.sort(key=lambda c: c.get("updatedAt", ""), reverse=True)
    return chats


def delete_chat(chat_id: str) -> bool:
    """
    Remove the chat.json for a chat. The workspace/attachments/git dirs
    are left intact (workspace.delete_workspace handles those separately).
    Returns True if the file existed and was deleted.
    """
    path = _chat_file(chat_id)
    if path.exists():
        path.unlink()
        return True
    return False


def chat_exists(chat_id: str) -> bool:
    return _chat_file(chat_id).exists()
