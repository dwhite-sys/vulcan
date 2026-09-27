"""
vulcan/auth.py — Server authentication

Server password (optional):
  Stored as an Argon2id hash in ~/.vulcan/server.passwd.
  Never stored as plaintext anywhere.
  If no password file exists, the server runs unauthenticated (local use).

Password hashing:
  Uses Argon2id with conservative parameters suitable for a server startup
  check — not a high-frequency online attack target, so we can afford
  slightly higher memory/time cost for stronger security.

Session management:
  Once a WebSocket client authenticates, a session token is issued.
  The session token is used to authorize subsequent WS messages.
  Sessions are in-memory only — restart clears all sessions.
"""

import os
import secrets
import time
from typing import Optional

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

from vulcan import config as cfg


# Argon2id parameters — conservative, suitable for server auth
_ph = PasswordHasher(
    time_cost=3,        # iterations
    memory_cost=65536,  # 64 MB
    parallelism=2,
    hash_len=32,
    salt_len=16,
)


# ── Password file management ──────────────────────────────────────────────────

def has_server_password() -> bool:
    """
    Return True only when a valid Argon2id server-password hash exists.

    A missing, empty, or malformed password file does not advertise password
    authentication to clients. The plaintext password is never stored.
    """
    if not cfg.SERVER_PASSWORD_FILE.exists():
        return False
    try:
        stored = cfg.SERVER_PASSWORD_FILE.read_text(encoding="utf-8").strip()
        if not stored or not stored.startswith("$argon2id$"):
            return False
        # Parsing through check_needs_rehash validates the encoded Argon2 hash
        # without requiring or recovering the original password.
        _ph.check_needs_rehash(stored)
        return True
    except (OSError, VerificationError, InvalidHashError, ValueError):
        return False


def set_server_password(password: str) -> None:
    """
    Hash password with Argon2id and store in SERVER_PASSWORD_FILE.
    Overwrites any existing password.
    """
    if not password:
        raise ValueError("Password cannot be empty")
    hashed = _ph.hash(password)
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    # Write atomically
    tmp = cfg.SERVER_PASSWORD_FILE.with_suffix(".tmp")
    tmp.write_text(hashed, encoding="utf-8")
    os.replace(tmp, cfg.SERVER_PASSWORD_FILE)


def clear_server_password() -> bool:
    """Remove the server password. Returns True if one existed."""
    if cfg.SERVER_PASSWORD_FILE.exists():
        cfg.SERVER_PASSWORD_FILE.unlink()
        return True
    return False


def verify_server_password(password: str) -> bool:
    """
    Verify a password against the stored hash.
    Returns False if no password is set (open server) or if wrong.
    """
    if not has_server_password():
        return False
    try:
        stored = cfg.SERVER_PASSWORD_FILE.read_text(encoding="utf-8").strip()
        _ph.verify(stored, password)
        return True
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash() -> bool:
    """Return True if the stored hash should be upgraded (parameters changed)."""
    if not has_server_password():
        return False
    try:
        stored = cfg.SERVER_PASSWORD_FILE.read_text(encoding="utf-8").strip()
        return _ph.check_needs_rehash(stored)
    except Exception:
        return False


# ── Session management ────────────────────────────────────────────────────────

class Session:
    def __init__(self, token: str, client_id: str):
        self.token      = token
        self.client_id  = client_id
        self.created_at = time.time()
        self.last_seen  = time.time()

    def touch(self):
        self.last_seen = time.time()


_sessions: dict[str, Session] = {}   # token → Session
SESSION_TTL = 3600  # 1 hour — generous, WebSocket disconnect handles cleanup


def create_session(client_id: str) -> str:
    """Create a new authenticated session, return the session token."""
    token = secrets.token_hex(32)
    _sessions[token] = Session(token=token, client_id=client_id)
    return token


def validate_session(token: str) -> Optional[Session]:
    """Return the session if valid and not expired, else None."""
    session = _sessions.get(token)
    if not session:
        return None
    if time.time() - session.last_seen > SESSION_TTL:
        del _sessions[token]
        return None
    session.touch()
    return session


def revoke_session(token: str) -> None:
    """Remove a session (on disconnect)."""
    _sessions.pop(token, None)


def cleanup_expired_sessions() -> int:
    """Remove expired sessions. Returns count removed."""
    now = time.time()
    expired = [t for t, s in _sessions.items() if now - s.last_seen > SESSION_TTL]
    for t in expired:
        del _sessions[t]
    return len(expired)


# ── Server state (loaded at startup) ─────────────────────────────────────────

def server_requires_auth() -> bool:
    """True if the server has a password set and requires authentication."""
    return has_server_password()
