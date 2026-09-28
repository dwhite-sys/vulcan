"""
vulcan/config.py — Config and directory management

Config lives at:
  Linux/macOS: ~/.vulcan/
  Windows:     %APPDATA%\\Vulcan\\

Directory layout:
  ~/.vulcan/
    config.json          — server runtime settings only (network endpoint definitions are client-owned)
    server.pid           — running Vulcan server PID
    runtime/             — Vulcan-managed Python environment
    python/              — Vulcan-managed Python installation
    bin/                 — Vulcan-private launchers/tools
    uv-tools/            — Vulcan-owned uv tool state
    payload/             — persisted packaged server payload + payload hash
    chats/               — also bind-mounted read-only at /chats for cross-chat file references
      <chat-uuid>/       — per-conversation data
        workspace/       — agent working directory, bind-mounted rw at /workspace
        attachments/     — user uploads, bind-mounted ro at /attachments
        environment.json — package manifest (host-only, never mounted)
        .git/            — git repo tracking workspace/ and environment.json
    shared/              — shared across all chats, bind-mounted rw at /shared
      library/           — canonical shared files, nested bind-mounted ro at /shared/library
    snapshots/
      <chat-uuid>/
        <file-stem>/     — local VS Code-style snapshots (not git)
          <timestamp>.json
"""

import json
import os
import sys
import threading
from pathlib import Path

_CONFIG_LOCK = threading.RLock()


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
LIBRARY_DIR     = SHARED_DIR / "library"
SNAPSHOTS_DIR   = CONFIG_DIR / "snapshots"
SERVER_PASSWORD_FILE = CONFIG_DIR / "server.passwd"  # Argon2 hash, never plaintext

DEFAULT_PORT    = 8468

DEFAULT_CONFIG = {
    "port":         DEFAULT_PORT,
    "vulcan": {
        "cli_workspace_enabled": False,
        # None = no Vulcan-imposed per-file upload limit. May also be set to
        # an integer byte count or a human-readable string such as "10GiB".
        "max_upload_size": None,
    },
    "containers": {
        # Set to 0 to retain the previous indefinitely-running behavior.
        "idle_timeout_seconds": 1800,
        "reap_interval_seconds": 30,
        "protect_active_runs": True,
        "protect_open_terminals": True,
        "protect_dashboard_services": True,
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
    with _CONFIG_LOCK:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_FILE.with_suffix(".tmp")
        with open(tmp, "w") as f:
            json.dump(config, f, indent=2)
        # Server config may contain sensitive server settings; keep it owner-only.
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, CONFIG_FILE)


def update(**kwargs):
    """Update top-level config keys and save without racing another writer."""
    with _CONFIG_LOCK:
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
    for d in [CHATS_DIR, SHARED_DIR, LIBRARY_DIR, SNAPSHOTS_DIR]:
        d.mkdir(parents=True, exist_ok=True)
