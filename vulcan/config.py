"""
vulcan/config.py — Config and directory management

Config lives at:
  Linux/macOS: ~/.vulcan/
  Windows:     %APPDATA%\\Vulcan\\

Directory layout:
  ~/.vulcan/
    config.json          — port, etna_url, inference config, vulcan settings
    server.pid           — running Vulcan server PID
    chats/
      <chat-uuid>/       — per-conversation data
        workspace/       — agent working directory, bind-mounted rw at /workspace
        attachments/     — user uploads, bind-mounted ro at /attachments
        environment.json — package manifest (host-only, never mounted)
        .git/            — git repo tracking workspace/ and environment.json
    shared/              — shared across all chats, bind-mounted rw at /shared
    snapshots/
      <chat-uuid>/
        <file-stem>/     — local VS Code-style snapshots (not git)
          <timestamp>.json
"""

import json
import os
import sys
from pathlib import Path


def _default_config_dir() -> Path:
    env_override = os.environ.get("VULCAN_CONFIG_DIR")
    if env_override:
        return Path(env_override)
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "Vulcan"
        return Path.home() / "AppData" / "Roaming" / "Vulcan"
    return Path.home() / ".vulcan"


CONFIG_DIR      = _default_config_dir()
CONFIG_FILE     = CONFIG_DIR / "config.json"
PID_FILE        = CONFIG_DIR / "server.pid"
CHATS_DIR       = CONFIG_DIR / "chats"
SHARED_DIR      = CONFIG_DIR / "shared"
SNAPSHOTS_DIR   = CONFIG_DIR / "snapshots"
SERVER_PASSWORD_FILE = CONFIG_DIR / "server.passwd"  # Argon2 hash, never plaintext

DEFAULT_PORT    = 8468

DEFAULT_CONFIG = {
    "port":         DEFAULT_PORT,
    "etna_url":     "http://localhost:8467",  # kit server URL
    "inference": {
        "base_url": "",
        "api_key":  "",
        "model":    "",
    },
    "vulcan": {
        "cli_workspace_enabled": False,
        # None = no Vulcan-imposed per-file upload limit. May also be set to
        # an integer byte count or a human-readable string such as "10GiB".
        "max_upload_size": None,
    },
}


def load() -> dict:
    if not CONFIG_FILE.exists():
        save(DEFAULT_CONFIG.copy())
        return DEFAULT_CONFIG.copy()
    with open(CONFIG_FILE) as f:
        data = json.load(f)
    # Merge defaults for any missing keys
    def _merge(base: dict, override: dict) -> dict:
        result = base.copy()
        for k, v in override.items():
            if k in result and isinstance(result[k], dict) and isinstance(v, dict):
                result[k] = _merge(result[k], v)
            else:
                result[k] = v
        return result
    return _merge(DEFAULT_CONFIG.copy(), data)


def save(config: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(config, f, indent=2)
    os.replace(tmp, CONFIG_FILE)


def update(**kwargs):
    """Update top-level config keys and save."""
    config = load()
    config.update(kwargs)
    save(config)


# ── Workspace helpers ─────────────────────────────────────────────────────────

def chat_dir(chat_id: str) -> Path:
    """Return the chat directory for a chat, creating subdirs if needed."""
    d = CHATS_DIR / chat_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "workspace").mkdir(exist_ok=True)
    (d / "attachments").mkdir(exist_ok=True)
    return d


def chat_workspace_dir(chat_id: str) -> Path:
    """Return the workspace/ subdir for a chat (the agent's working directory)."""
    return chat_dir(chat_id) / "workspace"


def chat_attachments_dir(chat_id: str) -> Path:
    """Return the attachments/ subdir for a chat."""
    return chat_dir(chat_id) / "attachments"


def chat_environment_json(chat_id: str) -> Path:
    """Return the path to environment.json for a chat."""
    return chat_dir(chat_id) / "environment.json"


def snapshot_dir(chat_id: str, file_stem: str) -> Path:
    d = SNAPSHOTS_DIR / chat_id / file_stem
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_dirs():
    """Create the top-level directory tree if it doesn't exist."""
    for d in [CHATS_DIR, SHARED_DIR, SNAPSHOTS_DIR]:
        d.mkdir(parents=True, exist_ok=True)
