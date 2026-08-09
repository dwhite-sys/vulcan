"""Server-side persistence for the chat sidebar folder hierarchy."""

import json
import os
from pathlib import Path

from vulcan import config as cfg


def _folders_file() -> Path:
    return cfg.CONFIG_DIR / "chat_folders.json"


def _atomic_write(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, default=str), encoding="utf-8")
    os.replace(tmp, path)


def load_folders() -> list[dict]:
    path = _folders_file()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_folders(folders: list[dict]) -> list[dict]:
    _atomic_write(_folders_file(), folders)
    return folders
