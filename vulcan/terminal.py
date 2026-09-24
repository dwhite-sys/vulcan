"""
vulcan/terminal.py

Three mechanisms, all stream to xterm:

1. SHELL  — persistent `docker exec -it bash` via PTY (legacy single-shell path)
             User types → master_fd → bash → output → SSE → xterm
             One per chat, lives until killed.

2. COMMAND — one-shot `docker exec -i cmd` via pipe
             Output captured → returned as tool result
             Same output also appended to xterm stream so user sees it.
             No shared state with the shell process.

3. SLOTS  — multi-slot PTY system (new)
             Up to 3 agent slots + 3 user slots per chat.
             Each slot is an independent bash PTY session with its own SSE stream.
             Agent slots: VULCAN_SESSION=agent:{slot}, read-only from xterm.
             User slots:  VULCAN_SESSION=user:{slot}, fully interactive.
             Slots are keyed by (chat_id, kind, slot_number).
             Inactivity auto-close: if no output and no running process for
             SLOT_INACTIVITY_SECONDS, the slot is closed and scrollback saved.

Isolation is provided by the per-chat Docker container.
"""

import asyncio
import fcntl
import json
import logging
import re
import os
import pty
import shutil
import struct
import subprocess
import termios
import threading
import time
import uuid
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from typing import Optional, AsyncIterator, Literal

from vulcan import docker
from vulcan import config as cfg

logger = logging.getLogger("vulcan.terminal")

SLOT_MAX           = 3                  # max slots per kind per chat
SLOT_INACTIVITY_S  = 300               # seconds of silence before auto-close
SlotKind = Literal['agent', 'user']

# Invisible OSC markers injected into interactive bash sessions. They let the
# backend distinguish a shell executing foreground work from one that has
# returned to its prompt, without guessing from cursor rendering/output.
# The collector strips these markers before forwarding output to xterm.
_ACTIVITY_BUSY_MARKER = '\x1b]777;vulcan-terminal;busy\x07'
_ACTIVITY_IDLE_MARKER = '\x1b]777;vulcan-terminal;idle\x07'
_ACTIVITY_MARKERS = (_ACTIVITY_BUSY_MARKER, _ACTIVITY_IDLE_MARKER)
_COMMAND_MARKER_PREFIX = '\x1b]777;vulcan-command;'


def _make_controlling_tty():
    """
    preexec_fn: make the child process a session leader and attach the PTY
    as its controlling terminal so the kernel knows which foreground process
    group to deliver SIGWINCH to when TIOCSWINSZ fires.
    Without this, $COLUMNS/$LINES inside bash never update on resize.
    """
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def _new_pid() -> str:
    """Generate a short unique process ID."""
    return uuid.uuid4().hex[:8]





# ── Multi-slot terminal system ────────────────────────────────────────────────

@dataclass
class TerminalSlot:
    chat_id:      str
    kind:         SlotKind          # 'agent' | 'user'
    slot:         int               # 1-3
    proc:         object            # Popen
    master_fd:    int
    output:       list              = field(default_factory=list)  # chunks for SSE
    finished:     bool             = False
    last_activity: float           = field(default_factory=time.time)
    has_running:  bool             = False   # True while an agent command owns this PTY
    prompt_busy:   bool             = False   # True after shell command start, until prompt returns
    marker_pending: str             = ''      # partial OSC marker split across PTY reads
    active_command: object          = None    # CommandProcess currently executing in this shell
    last_command_pid: str | None    = None    # Retained after completion so wait(slot) cannot lose exit status
    capture_active: bool            = False   # Start capture after bash has consumed command input
    shell_integration: bool         = False   # PS0/PS1 markers installed for this PTY
    fd_lock: object                 = field(default_factory=threading.Lock)
    close_reason: str               = ''
    persisted: bool                 = False    # current session output has been merged into scrollback
    cols: int                       = 80
    rows: int                       = 24
    resume_notice: str              = ''        # one-shot agent-visible revival notice
    generation: str                 = field(default_factory=lambda: uuid.uuid4().hex)

    @property
    def is_busy(self) -> bool:
        return self.has_running or self.prompt_busy

    @property
    def slot_id(self) -> str:
        return f"{self.chat_id}:{self.kind}:{self.slot}"


# (chat_id, kind, slot) → TerminalSlot
_slots:      dict[tuple, TerminalSlot] = {}
_slots_lock = threading.Lock()
# Recovery is single-flight per chat/kind. Multiple terminal tools arriving after
# an idle park/server restart join one Docker + PTY resurrection instead of each
# independently probing/restarting the same environment.
_resume_locks: dict[tuple[str, str], threading.Lock] = {}
_resume_locks_guard = threading.Lock()
# Physical PTY creation/revival/retirement is serialized per logical slot.
_slot_lifecycle_locks: dict[tuple[str, str, int], threading.RLock] = {}
_slot_lifecycle_locks_guard = threading.Lock()

# Per-chat scrollback storage: (chat_id, kind, slot) → serialized string
_scrollbacks: dict[tuple, str] = {}
_scrollback_lock = threading.RLock()




def _slot_lifecycle_lock(chat_id: str, kind: SlotKind, slot: int) -> threading.RLock:
    key = (chat_id, kind, int(slot))
    with _slot_lifecycle_locks_guard:
        lock = _slot_lifecycle_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _slot_lifecycle_locks[key] = lock
        return lock


def _recoverable_reasons(kind: SlotKind) -> set[str]:
    return _AGENT_RECOVERABLE_REASONS if kind == "agent" else _LIFECYCLE_REOPEN_REASONS

def _close_slot_fd(ts: TerminalSlot):
    """Close a PTY exactly once; fd reuse makes double-closing dangerous."""
    with ts.fd_lock:
        fd = ts.master_fd
        if fd < 0:
            return
        ts.master_fd = -1
        try:
            os.close(fd)
        except OSError:
            pass


def _slot_key(chat_id: str, kind: SlotKind, slot: int) -> tuple:
    return (chat_id, kind, slot)


def _slots_file(chat_id: str) -> 'Path':
    from pathlib import Path
    return cfg.chat_dir(chat_id) / "terminal_slots.json"


def _save_slot_meta(chat_id: str):
    """Persist scrollback without discarding durable logical-slot metadata."""
    with _scrollback_lock:
        data = _load_slot_meta(chat_id)
        for (cid, kind, slot), scrollback in _scrollbacks.items():
            if cid != chat_id:
                continue
            key = f"{kind}:{slot}"
            entry = data.setdefault(key, {})
            entry["scrollback"] = scrollback
        path = _slots_file(chat_id)
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data, default=str), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            logger.warning("Could not persist terminal slot metadata for %s", chat_id, exc_info=True)
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass


def _update_slot_meta(chat_id: str, kind: SlotKind, slot: int, **values):
    """Atomically merge durable metadata for one logical terminal slot."""
    with _scrollback_lock:
        data = _load_slot_meta(chat_id)
        entry = data.setdefault(f"{kind}:{slot}", {})
        entry.update(values)
        key = _slot_key(chat_id, kind, slot)
        if key in _scrollbacks:
            entry["scrollback"] = _scrollbacks[key]
        path = _slots_file(chat_id)
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data, default=str), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            logger.warning("Could not persist terminal slot metadata for %s", chat_id, exc_info=True)
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass


def get_slot_focus(chat_id: str, kind: SlotKind) -> int | None:
    """Return the durable selected slot for one terminal kind."""
    with _scrollback_lock:
        data = _load_slot_meta(chat_id)
        focus = data.get("_focus")
        if not isinstance(focus, dict):
            return None
        raw = focus.get(kind)
        if isinstance(raw, bool):
            return None
        try:
            slot = int(raw)
        except (TypeError, ValueError):
            return None
        return slot if 1 <= slot <= SLOT_MAX else None


def set_slot_focus(chat_id: str, kind: SlotKind, slot: int | None) -> None:
    """Persist terminal selection independently of an individual AgentRun."""
    if slot is not None:
        slot = int(slot)
        if slot < 1 or slot > SLOT_MAX:
            raise ValueError(f"Terminal slot must be between 1 and {SLOT_MAX}")

    with _scrollback_lock:
        data = _load_slot_meta(chat_id)
        focus = data.get("_focus")
        if not isinstance(focus, dict):
            focus = {}

        if slot is None:
            focus.pop(kind, None)
        else:
            focus[kind] = slot

        if focus:
            data["_focus"] = focus
        else:
            data.pop("_focus", None)

        path = _slots_file(chat_id)
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data, default=str), encoding="utf-8")
            os.replace(tmp, path)
        except Exception:
            logger.warning(
                "Could not persist terminal focus for %s:%s",
                chat_id, kind, exc_info=True,
            )
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass


def clear_slot_focus_if_matches(
    chat_id: str,
    kind: SlotKind,
    slot: int,
) -> bool:
    """Clear durable focus only if it still points at this slot."""
    with _scrollback_lock:
        data = _load_slot_meta(chat_id)
        focus = data.get("_focus")
        if not isinstance(focus, dict):
            return False

        raw = focus.get(kind)
        if isinstance(raw, bool):
            return False
        try:
            current = int(raw)
        except (TypeError, ValueError):
            return False

        if current != int(slot):
            return False

        focus.pop(kind, None)
        if focus:
            data["_focus"] = focus
        else:
            data.pop("_focus", None)

        path = _slots_file(chat_id)
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data, default=str), encoding="utf-8")
            os.replace(tmp, path)
            return True
        except Exception:
            logger.warning(
                "Could not clear terminal focus for %s:%s:%s",
                chat_id, kind, slot, exc_info=True,
            )
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
            return False


def _persisted_slot_entry(chat_id: str, kind: SlotKind, slot: int) -> dict:
    value = _load_slot_meta(chat_id).get(f"{kind}:{slot}")
    return value if isinstance(value, dict) else {}

def _clear_slot_revival_state(chat_id: str, kind: SlotKind, slot: int) -> None:
    """Forget relaunch state when a logical terminal is explicitly retired."""
    if not docker.container_running(chat_id):
        return
    home = docker.terminal_home(kind, slot)
    try:
        docker.run_docker(
            ["exec", docker.container_name(chat_id), "rm", "-f",
             f"{home}/.vulcan-cwd", f"{home}/.vulcan-env"],
            capture_output=True,
        )
    except Exception:
        logger.debug("Could not clear terminal revival state for %s:%s:%s", chat_id, kind, slot, exc_info=True)



_LIFECYCLE_NOTICE_RE = re.compile(
    r"(?:\r?\n)?(?:\x1b\[2m)?\[Terminal closed(?: due to inactivity)?\](?:\x1b\[0m)?(?:\r?\n)?"
)


def _strip_lifecycle_notices(scrollback: str | None) -> str:
    """Remove closure notices emitted by older Vulcan versions from durable scrollback."""
    if not scrollback:
        return scrollback or ""
    return _LIFECYCLE_NOTICE_RE.sub("\n", scrollback)


def _load_slot_meta(chat_id: str) -> dict:
    """Load persisted slot metadata from disk."""
    try:
        path = _slots_file(chat_id)
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def get_slot_scrollback(chat_id: str, kind: SlotKind, slot: int) -> str | None:
    """Return saved scrollback for a slot, checking memory then disk."""
    key = _slot_key(chat_id, kind, slot)
    with _scrollback_lock:
        if key in _scrollbacks:
            cleaned = _strip_lifecycle_notices(_scrollbacks[key])
            _scrollbacks[key] = cleaned
            return cleaned
    # Try disk. Older builds persisted lifecycle notices as terminal text;
    # scrub those while hydrating so existing spam disappears after upgrade.
    meta = _load_slot_meta(chat_id)
    entry = meta.get(f"{kind}:{slot}")
    if entry:
        raw = entry.get("scrollback")
        cleaned = _strip_lifecycle_notices(raw)
        if cleaned != (raw or ""):
            with _scrollback_lock:
                _scrollbacks[key] = cleaned
                _save_slot_meta(chat_id)
        return cleaned
    return None


def save_slot_scrollback(chat_id: str, kind: SlotKind, slot: int, scrollback: str):
    """Save serialized xterm scrollback for a slot."""
    key = _slot_key(chat_id, kind, slot)
    with _scrollback_lock:
        _scrollbacks[key] = _strip_lifecycle_notices(scrollback)
        _save_slot_meta(chat_id)


def active_chat_ids() -> list[str]:
    """Return chat ids with at least one terminal actively doing foreground work."""
    with _slots_lock:
        return sorted({
            cid for (cid, _kind, _slot), ts in _slots.items()
            if not ts.finished and ts.is_busy
        })


def terminal_chat_statuses() -> dict[str, dict[str, bool]]:
    """Return per-chat user/agent terminal presence and foreground activity."""
    statuses: dict[str, dict[str, bool]] = {}
    with _slots_lock:
        for (cid, kind, _slot), ts in _slots.items():
            if ts.finished:
                continue
            status = statuses.setdefault(cid, {
                "user_open": False, "user_busy": False,
                "agent_open": False, "agent_busy": False,
            })
            status[f"{kind}_open"] = True
            if ts.is_busy:
                status[f"{kind}_busy"] = True
    return statuses


def list_slots(chat_id: str) -> list[dict]:
    """List physical slots plus persisted logical slots from prior server lifetimes."""
    result = []
    seen: set[tuple[str, int]] = set()
    with _slots_lock:
        for (cid, kind, slot), ts in _slots.items():
            if cid != chat_id:
                continue
            seen.add((kind, slot))
            recoverable_reasons = _AGENT_RECOVERABLE_REASONS if kind == "agent" else _LIFECYCLE_REOPEN_REASONS
            logical_open = (not ts.finished) or ts.close_reason in recoverable_reasons
            result.append({
                "kind": kind,
                "slot": slot,
                "finished": ts.finished,
                "logical_open": logical_open,
                "close_reason": ts.close_reason,
                "has_running": ts.is_busy if not ts.finished else False,
                "last_activity": ts.last_activity,
            })
    for key, entry in _load_slot_meta(chat_id).items():
        if not isinstance(entry, dict) or not entry.get("open"):
            continue
        try:
            persisted_kind, raw_slot = key.split(":", 1)
            persisted_slot = int(raw_slot)
        except (ValueError, TypeError):
            continue
        if persisted_kind not in ("agent", "user") or (persisted_kind, persisted_slot) in seen:
            continue
        result.append({
            "kind": persisted_kind,
            "slot": persisted_slot,
            "finished": True,
            "logical_open": True,
            "close_reason": entry.get("close_reason") or "persisted",
            "has_running": False,
            "last_activity": float(entry.get("last_activity") or 0),
        })
    return sorted(result, key=lambda x: (x["kind"], x["slot"]))

def live_slot_states(chat_id: str, kind: SlotKind, slots: list[int]) -> list[dict] | None:
    """Cheap in-memory states, or ``None`` if any logical slot needs recovery."""
    if not slots:
        return None
    values: list[dict] = []
    with _slots_lock:
        for slot in slots:
            ts = _slots.get(_slot_key(chat_id, kind, int(slot)))
            if ts is None or ts.finished:
                return None
            command = ts.active_command
            values.append({
                "slot": int(slot),
                "running": ts.is_busy,
                "pid": command.pid if command is not None else ts.last_command_pid,
            })
    return values


def slot_state(chat_id: str, kind: SlotKind, slot: int) -> dict | None:
    """Return the physical live-shell state for a slot."""
    with _slots_lock:
        ts = _slots.get(_slot_key(chat_id, kind, slot))
        if ts is None or ts.finished:
            return None
        command = ts.active_command
        return {
            "slot": slot,
            "running": ts.is_busy,
            "pid": command.pid if command is not None else ts.last_command_pid,
        }


def agent_slot_state(chat_id: str, kind: SlotKind, slot: int) -> dict | None:
    """Return the logical state exposed to agent tools across persisted revivals.

    Parked or persisted slots remain logically open and idle. The terminal tools
    surface the revival boundary once, after the backing shell is relaunched.
    """
    live = slot_state(chat_id, kind, slot)
    if live is not None:
        return live
    with _slots_lock:
        ts = _slots.get(_slot_key(chat_id, kind, slot))
        if ts is not None and ts.finished and ts.close_reason in _recoverable_reasons(kind):
            return {"slot": slot, "running": False, "pid": None}
    if _persisted_slot_entry(chat_id, kind, slot).get("open"):
        return {"slot": slot, "running": False, "pid": None}
    return None


def _next_slot(chat_id: str, kind: SlotKind) -> int | None:
    """Return the lowest logically available slot number (1-3), or None if full.

    Lifecycle-parked slots remain part of the terminal set from the agent/user's
    perspective, so opening an additional terminal must not silently recycle one.
    """
    used = {
        slot for (cid, k, slot), ts in _slots.items()
        if cid == chat_id and k == kind
        and (not ts.finished or ts.close_reason in _recoverable_reasons(kind))
    }
    for key, entry in _load_slot_meta(chat_id).items():
        if not isinstance(entry, dict) or not entry.get("open"):
            continue
        try:
            persisted_kind, raw_slot = key.split(":", 1)
            persisted_slot = int(raw_slot)
        except (ValueError, TypeError):
            continue
        if persisted_kind == kind:
            used.add(persisted_slot)
    for n in range(1, SLOT_MAX + 1):
        if n not in used:
            return n
    return None


def _read_slot_revival_state(chat_id: str, kind: SlotKind, slot: int) -> tuple[str | None, list[str]]:
    """Read the last prompt-level cwd/exported environment captured inside the slot HOME."""
    home = docker.terminal_home(kind, slot)
    cwd_result = docker.run_docker(
        ["exec", docker.container_name(chat_id), "cat", f"{home}/.vulcan-cwd"],
        capture_output=True, text=True,
    )
    cwd = cwd_result.stdout.strip() if cwd_result.returncode == 0 else None

    env_result = docker.run_docker(
        ["exec", docker.container_name(chat_id), "cat", f"{home}/.vulcan-env"],
        capture_output=True,
    )
    values: list[str] = []
    controlled = {"HOME", "PWD", "OLDPWD", "SHLVL", "_", "TERM", "COLORTERM",
                  "VULCAN_SESSION", "VULCAN_CHAT_ID", "VULCAN_NODE"}
    if env_result.returncode == 0:
        raw = env_result.stdout if isinstance(env_result.stdout, bytes) else str(env_result.stdout).encode()
        for item in raw.split(b"\0"):
            if b"=" not in item:
                continue
            name, value = item.split(b"=", 1)
            try:
                key = name.decode("utf-8")
                decoded = value.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or key in controlled:
                continue
            values.append(f"{key}={decoded}")
    return cwd or None, values


def _install_slot_shell_integration(chat_id: str, kind: SlotKind, slot: int) -> str:
    """Create a bash rcfile in the backing container and return its path.

    Bash expands PS0 immediately before executing an interactive command, while
    PS1 is expanded when the shell has regained control and is ready for another
    command. Private OSC markers in those expansions give us exact busy/idle
    transitions without changing the visible prompt.
    """
    safe_chat = ''.join(c if c.isalnum() or c in '-_' else '_' for c in chat_id)
    rc_path = f"/tmp/vulcan-{safe_chat}-{kind}-{slot}.bashrc"
    prompt_identity = f"{chat_id}@vulcan"
    rc = fr"""# Vulcan terminal shell integration
[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -r ~/.bashrc ] && . ~/.bashrc
__vulcan_persist_terminal_state() {{
  printf '%s\n' "$PWD" > "$HOME/.vulcan-cwd.tmp" && mv "$HOME/.vulcan-cwd.tmp" "$HOME/.vulcan-cwd"
  env -0 > "$HOME/.vulcan-env.tmp" && mv "$HOME/.vulcan-env.tmp" "$HOME/.vulcan-env"
  history -a >/dev/null 2>&1 || true
}}
if [ -n "${{PROMPT_COMMAND-}}" ]; then
  PROMPT_COMMAND="__vulcan_persist_terminal_state;${{PROMPT_COMMAND}}"
else
  PROMPT_COMMAND="__vulcan_persist_terminal_state"
fi
PS0=$'\033]777;vulcan-terminal;busy\007'"${{PS0-}}"
PS1=$'\033]777;vulcan-terminal;idle\007'"{prompt_identity}:\w\$ "
export PS0 PS1
"""
    try:
        docker.run_docker(
            ['exec', '-i', docker.container_name(chat_id), 'bash', '-c', f'cat > {rc_path}'],
            input=rc,
            text=True,
            capture_output=True,
            check=True,
        )
    except Exception:
        # Terminal opening should still succeed if shell integration cannot be
        # installed. It simply won't report prompt activity for this slot.
        return ''
    return rc_path


def _strip_activity_markers(ts: TerminalSlot, chunk: str) -> str:
    """Consume private OSC markers, forwarding only actual command output."""
    data = ts.marker_pending + chunk
    ts.marker_pending = ''
    visible: list[str] = []

    def emit(text: str):
        if not text:
            return
        visible.append(text)
        command = ts.active_command
        if command is not None and ts.capture_active and not command.detached:
            command.output.append(text)

    while data:
        found = []
        for marker in (*_ACTIVITY_MARKERS, _COMMAND_MARKER_PREFIX):
            pos = data.find(marker)
            if pos >= 0:
                found.append((pos, marker))

        if found:
            pos, marker = min(found, key=lambda pair: pair[0])
            emit(data[:pos])
            if marker == _COMMAND_MARKER_PREFIX:
                ending = data.find('\x07', pos + len(marker))
                if ending < 0:
                    ts.marker_pending = data[pos:]
                    break
                payload = data[pos + len(marker):ending]
                command_id, separator, status = payload.partition(';')
                command = ts.active_command
                if separator and command is not None and command.pid == command_id:
                    try:
                        command.exit_code = int(status)
                    except ValueError:
                        command.exit_code = 1
                    command.finished = True
                    ts.active_command = None
                    ts.capture_active = False
                    ts.has_running = False
                data = data[ending + 1:]
                ts.last_activity = time.time()
                continue

            if marker == _ACTIVITY_BUSY_MARKER:
                ts.prompt_busy = True
                if ts.active_command is not None:
                    ts.capture_active = True
            else:
                ts.prompt_busy = False
                command = ts.active_command
                if command is not None and ts.capture_active:
                    # Ctrl-C can return to the prompt before the completion
                    # marker executes; do not leave the slot permanently busy.
                    command.exit_code = 130
                    command.finished = True
                    ts.active_command = None
                    ts.capture_active = False
                    ts.has_running = False
            ts.last_activity = time.time()
            data = data[pos + len(marker):]
            continue

        # PTY reads can split an OSC marker. Retain the longest trailing suffix
        # that could be the start of either marker and emit everything else.
        keep = 0
        for marker in (*_ACTIVITY_MARKERS, _COMMAND_MARKER_PREFIX):
            max_n = min(len(data), len(marker) - 1)
            for n in range(max_n, 0, -1):
                if data.endswith(marker[:n]):
                    keep = max(keep, n)
                    break
        if keep:
            emit(data[:-keep])
            ts.marker_pending = data[-keep:]
        else:
            emit(data)
        break

    return ''.join(visible)


def _persist_slot_output(ts: TerminalSlot):
    """Merge one finished PTY session into durable server-owned scrollback exactly once."""
    if ts.persisted:
        return
    key = _slot_key(ts.chat_id, ts.kind, ts.slot)
    with _scrollback_lock:
        previous = _scrollbacks.get(key)
        if previous is None:
            meta = _load_slot_meta(ts.chat_id)
            previous = (meta.get(f"{ts.kind}:{ts.slot}") or {}).get("scrollback", "")
        previous = _strip_lifecycle_notices(previous)
        _scrollbacks[key] = previous + "".join(ts.output)
        _save_slot_meta(ts.chat_id)
        ts.persisted = True


def _start_slot_proc(chat_id: str, kind: SlotKind, slot: int, cols: int = 80, rows: int = 24) -> TerminalSlot:
    """Spawn a new PTY bash session for a slot."""
    master_fd, slave_fd = pty.openpty()
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', max(1, rows), max(1, cols), 0, 0))
    except Exception:
        pass

    session_var = f"VULCAN_SESSION={chat_id}:{kind}:{slot}"
    revive_cwd, revive_env = _read_slot_revival_state(chat_id, kind, slot)
    prefix = ['wsl'] if docker._is_windows() else []
    # util-linux setsid performs the controlling-TTY setup in native code,
    # avoiding Python preexec_fn after the server has started worker threads.
    session_prefix = prefix + ['setsid', '--ctty'] if (docker._is_windows() or shutil.which('setsid')) else prefix
    workdir = revive_cwd or docker.workspace_path(chat_id)
    # docker exec rejects a missing -w path. A stale cwd therefore falls back to
    # /workspace while preserving the rest of the revived environment.
    if revive_cwd:
        exists = docker.run_docker(
            ["exec", docker.container_name(chat_id), "test", "-d", revive_cwd],
            capture_output=True,
        ).returncode == 0
        if not exists:
            workdir = docker.workspace_path(chat_id)
    if not docker.prepare_terminal_identity(chat_id, kind, slot):
        os.close(master_fd)
        os.close(slave_fd)
        raise RuntimeError(f"Could not prepare isolated HOME for {chat_id}:{kind}:{slot}")
    shell_prefix = 'umask 000'
    rc_path = _install_slot_shell_integration(chat_id, kind, slot)
    interactive_shell = ['/bin/bash', '--rcfile', rc_path, '-i'] if rc_path else ['/bin/bash', '-i']
    proc = subprocess.Popen(
        session_prefix + [
            'docker', 'exec', '-it', *docker.terminal_exec_flags(chat_id, kind, slot),
            *sum((["-e", value] for value in revive_env), []),
            '-w', workdir,
            '-e', 'TERM=xterm-256color',
            '-e', 'COLORTERM=truecolor',
            '-e', session_var,
            docker.container_name(chat_id),
            '/bin/bash', '-c', f'{shell_prefix}; exec "$@"', 'vulcan-shell', *interactive_shell,
        ],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    ts = TerminalSlot(chat_id=chat_id, kind=kind, slot=slot, proc=proc,
                      master_fd=master_fd, shell_integration=bool(rc_path),
                      cols=max(1, int(cols)), rows=max(1, int(rows)))

    def _collect():
        try:
            while True:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    chunk = data.decode('utf-8', errors='replace')
                    visible = _strip_activity_markers(ts, chunk)
                    if visible:
                        ts.output.append(visible)
                    ts.last_activity = time.time()
                except OSError:
                    break
        finally:
            # Record an unplanned shell death before publishing `finished`. This
            # closes the tiny window where another tool can observe a dead slot
            # without knowing that it is eligible for transparent agent recovery.
            if not ts.close_reason:
                ts.close_reason = "process-exit"
            ts.finished = True
            command = ts.active_command
            if command is not None and not command.finished:
                command.exit_code = 1
                command.finished = True
            ts.active_command = None
            ts.capture_active = False
            ts.has_running = False
            _close_slot_fd(ts)
            _persist_slot_output(ts)
            if ts.close_reason == "process-exit":
                try:
                    returncode = ts.proc.poll()
                except Exception:
                    returncode = None
                tail = _strip_lifecycle_notices("".join(ts.output))[-1000:]
                logger.warning(
                    "Terminal PTY exited unexpectedly chat=%s kind=%s slot=%s returncode=%r tail=%r",
                    ts.chat_id, ts.kind, ts.slot, returncode, tail,
                )
                # Agent terminals are logical resources selected by the model. A transient
                # docker-exec/PTY death must not invalidate that selection; park the slot so
                # the next terminal operation can revive it transparently. User terminals
                # keep the traditional shell-exit semantics (typing `exit` closes them).
                recoverable = ts.kind == "agent"
                # A demand-triggered revival may already have replaced this TerminalSlot
                # while the collector was waking up from PTY EOF. Never let the retired
                # collector overwrite the new shell's fresh metadata.
                with _slots_lock:
                    current = _slots.get(_slot_key(ts.chat_id, ts.kind, ts.slot))
                    still_current = current is ts and current.generation == ts.generation
                if still_current:
                    _update_slot_meta(
                        ts.chat_id, ts.kind, ts.slot, open=recoverable, parked=recoverable,
                        close_reason="process-exit", cols=ts.cols, rows=ts.rows,
                        last_activity=ts.last_activity, generation=ts.generation,
                    )
                    if not recoverable:
                        clear_slot_focus_if_matches(ts.chat_id, ts.kind, ts.slot)

    threading.Thread(target=_collect, daemon=True).start()
    _start_inactivity_watcher(ts)
    return ts


def _start_inactivity_watcher(ts: TerminalSlot):
    """Background thread that auto-closes a slot after inactivity."""
    def _watch():
        while not ts.finished:
            time.sleep(10)
            if ts.finished:
                break
            idle = time.time() - ts.last_activity
            if not ts.is_busy and idle > SLOT_INACTIVITY_S:
                close_slot(ts.chat_id, ts.kind, ts.slot, reason='inactivity')
                break
    threading.Thread(target=_watch, daemon=True).start()


def _start_logical_slot_locked(chat_id: str, kind: SlotKind, slot: int, *, cols: int, rows: int) -> TerminalSlot:
    """Create one physical PTY incarnation for a logical slot. Caller owns its lifecycle lock."""
    _ensure_chat_dirs(chat_id)
    if not docker.ensure_container_running(chat_id):
        raise RuntimeError(f"Could not start the workspace container for chat {chat_id}")
    if not docker.prepare_workspace_identity(chat_id):
        raise RuntimeError("Could not prepare host-owned workspace permissions")
    ts = _start_slot_proc(chat_id, kind, slot, cols=max(1, int(cols)), rows=max(1, int(rows)))
    key = _slot_key(chat_id, kind, slot)
    with _slots_lock:
        _slots[key] = ts
    _update_slot_meta(
        chat_id, kind, slot, open=True, parked=False, close_reason="",
        cols=ts.cols, rows=ts.rows, last_activity=ts.last_activity, generation=ts.generation,
    )
    return ts


def open_slot(chat_id: str, kind: SlotKind, preferred_slot: int | None = None, *, cols: int = 80, rows: int = 24) -> int:
    """Open a new logical terminal slot attached to this chat's workspace container."""
    _ensure_chat_dirs(chat_id)
    if preferred_slot is not None:
        slot = int(preferred_slot)
        if slot < 1 or slot > SLOT_MAX:
            raise ValueError(f"Terminal slot must be between 1 and {SLOT_MAX}")
    else:
        with _slots_lock:
            slot = _next_slot(chat_id, kind)
        if slot is None:
            raise ValueError(
                f"Maximum of {SLOT_MAX} {kind} terminals already open. "
                f"Close an existing terminal with close_terminal(slot) before opening a new one."
            )

    with _slot_lifecycle_lock(chat_id, kind, slot):
        key = _slot_key(chat_id, kind, slot)
        with _slots_lock:
            existing = _slots.get(key)
        entry = _persisted_slot_entry(chat_id, kind, slot)
        logical_open = bool(entry.get("open")) or (
            existing is not None and (not existing.finished or existing.close_reason in _recoverable_reasons(kind))
        )
        if logical_open:
            # Preserve the historical explicit-resume behavior for a parked preferred
            # slot, but still reject attempts to duplicate a live physical shell.
            if preferred_slot is not None and (existing is None or existing.finished):
                revived = ensure_live_slot(chat_id, kind, slot, cols=cols, rows=rows)
                if revived is not None and not revived.finished:
                    return slot
            raise ValueError(f"Terminal {slot} is already open")
        _start_logical_slot_locked(chat_id, kind, slot, cols=cols, rows=rows)
    return slot

def _close_slot_locked(chat_id: str, kind: SlotKind, slot: int, reason: str = 'explicit'):
    """Close a terminal slot, killing the PTY immediately.

    An explicit close also retires a previously lifecycle-parked logical slot so
    it can be reused normally.
    """
    key = _slot_key(chat_id, kind, slot)
    with _slots_lock:
        ts = _slots.get(key)
        if not ts:
            entry = _persisted_slot_entry(chat_id, kind, slot)
            if reason == 'explicit' and entry.get("open"):
                with _scrollback_lock:
                    _scrollbacks.pop(key, None)
                _clear_slot_revival_state(chat_id, kind, slot)
                _update_slot_meta(chat_id, kind, slot, open=False, parked=False, close_reason='explicit', scrollback='')
                clear_slot_focus_if_matches(chat_id, kind, slot)
            return
        if ts.finished:
            recoverable_reasons = _AGENT_RECOVERABLE_REASONS if kind == 'agent' else _LIFECYCLE_REOPEN_REASONS
            if reason == 'explicit' and ts.close_reason in recoverable_reasons:
                ts.close_reason = 'explicit'
                with _scrollback_lock:
                    _scrollbacks.pop(key, None)
                _clear_slot_revival_state(chat_id, kind, slot)
                _update_slot_meta(chat_id, kind, slot, open=False, parked=False, close_reason='explicit', scrollback='')
                clear_slot_focus_if_matches(chat_id, kind, slot)
            return
        ts.close_reason = reason
        ts.finished = True
        try:
            ts.proc.kill()
        except Exception:
            pass
        _close_slot_fd(ts)
        # Lifecycle state is reported out-of-band through close_reason/slot status.
        # Do not append Vulcan-generated closure notices to PTY output: scrollback
        # should contain only shell/application output, otherwise repeated idle
        # close/reopen cycles accumulate misleading status graffiti forever.
        _persist_slot_output(ts)
        logical_open = reason in _LIFECYCLE_REOPEN_REASONS
        if reason == 'explicit':
            with _scrollback_lock:
                _scrollbacks.pop(key, None)
            _clear_slot_revival_state(chat_id, kind, slot)
        _update_slot_meta(
            chat_id, kind, slot, open=logical_open, parked=logical_open,
            close_reason=reason, cols=ts.cols, rows=ts.rows, last_activity=ts.last_activity,
            **({"scrollback": ""} if reason == 'explicit' else {}),
        )
        if not logical_open:
            clear_slot_focus_if_matches(chat_id, kind, slot)


def close_slot(chat_id: str, kind: SlotKind, slot: int, reason: str = 'explicit'):
    """Serialize retirement with creation/revival for the same logical slot."""
    with _slot_lifecycle_lock(chat_id, kind, slot):
        return _close_slot_locked(chat_id, kind, slot, reason=reason)


def close_chat_slots(chat_id: str, reason: str = 'explicit'):
    """Close every live terminal slot belonging to a chat/container."""
    with _slots_lock:
        keys = [key for key, ts in _slots.items() if key[0] == chat_id and not ts.finished]
    for _, kind, slot in keys:
        close_slot(chat_id, kind, slot, reason=reason)


def resize_slot(chat_id: str, kind: SlotKind, slot: int, cols: int, rows: int):
    """Resize a slot's PTY window."""
    key = _slot_key(chat_id, kind, slot)
    ts = _slots.get(key)
    if not ts or ts.finished:
        return
    try:
        ts.cols = max(1, int(cols))
        ts.rows = max(1, int(rows))
        fcntl.ioctl(ts.master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', ts.rows, ts.cols, 0, 0))
        _update_slot_meta(chat_id, kind, slot, cols=ts.cols, rows=ts.rows, last_activity=ts.last_activity)
    except Exception:
        pass


_LIFECYCLE_REOPEN_REASONS = {"inactivity", "container-stopped"}
_AGENT_RECOVERABLE_REASONS = _LIFECYCLE_REOPEN_REASONS | {"process-exit"}


def ensure_live_slot(
    chat_id: str, kind: SlotKind, slot: int, *,
    cols: int | None = None, rows: int | None = None, create: bool = False,
) -> TerminalSlot | None:
    """Return a live PTY for one logical slot, reviving it exactly once if needed.

    The logical identity is (chat_id, kind, slot). `chat_id` is also the workspace
    container identity; revival always re-enters that same container and /workspace.
    Physical PTYs have generation IDs so stale collectors cannot retire replacements.
    """
    slot = int(slot)
    if slot < 1 or slot > SLOT_MAX:
        return None
    key = _slot_key(chat_id, kind, slot)
    with _slot_lifecycle_lock(chat_id, kind, slot):
        with _slots_lock:
            ts = _slots.get(key)
        entry = _persisted_slot_entry(chat_id, kind, slot)
        reason = ""

        if ts is not None and not ts.finished:
            try:
                process_exited = ts.proc.poll() is not None
            except Exception:
                process_exited = False
            if not process_exited:
                if cols is not None and rows is not None:
                    resize_slot(chat_id, kind, slot, cols, rows)
                return ts
            # Publish the physical death only if this generation is still authoritative.
            ts.close_reason = ts.close_reason or "process-exit"
            ts.finished = True
            _close_slot_fd(ts)
            _persist_slot_output(ts)
            recoverable = kind == "agent"
            _update_slot_meta(
                chat_id, kind, slot, open=recoverable, parked=recoverable,
                close_reason="process-exit", cols=ts.cols, rows=ts.rows,
                last_activity=ts.last_activity, generation=ts.generation,
            )
            if not recoverable:
                clear_slot_focus_if_matches(chat_id, kind, slot)
            entry = _persisted_slot_entry(chat_id, kind, slot)

        if ts is not None:
            if not ts.finished:
                return ts
            if ts.close_reason in _recoverable_reasons(kind):
                reason = ts.close_reason
            elif create and not entry.get("open"):
                reason = "create"
            else:
                return None
        elif entry.get("open"):
            reason = str(entry.get("close_reason") or "persisted")
        elif create:
            reason = "create"
        else:
            return None

        target_cols = int(cols or entry.get("cols") or getattr(ts, "cols", 80) or 80)
        target_rows = int(rows or entry.get("rows") or getattr(ts, "rows", 24) or 24)
        revived = _start_logical_slot_locked(
            chat_id, kind, slot, cols=target_cols, rows=target_rows
        )
        if reason == "process-exit":
            revived.resume_notice = (
                f"Terminal {slot} recovered after its backing shell exited unexpectedly. "
                "Its persisted scrollback, working directory, and exported environment were restored."
            )
        elif reason in _LIFECYCLE_REOPEN_REASONS:
            revived.resume_notice = (
                f"Terminal {slot} resumed after inactivity. Its persisted scrollback, "
                "working directory, and exported environment were restored."
            )
        elif reason == "persisted":
            revived.resume_notice = (
                f"Terminal {slot} resumed from its persisted session. Its prior scrollback, "
                "working directory, and exported environment were restored."
            )
        return revived


def _revive_slot_if_lifecycled(chat_id: str, kind: SlotKind, slot: int) -> TerminalSlot | None:
    """Compatibility wrapper; all lifecycle ownership lives in ensure_live_slot()."""
    return ensure_live_slot(chat_id, kind, slot)


def ensure_slot_resumed(chat_id: str, kind: SlotKind, slot: int) -> TerminalSlot | None:
    """Public demand hook used by terminal tools that inspect or interact with a slot."""
    return ensure_live_slot(chat_id, kind, slot)


def consume_slot_resume_notice(chat_id: str, kind: SlotKind, slot: int) -> str:
    """Return and clear the one-shot agent-visible revival notice."""
    ts = _slots.get(_slot_key(chat_id, kind, slot))
    if ts is None:
        return ""
    notice = ts.resume_notice
    ts.resume_notice = ""
    return notice

def send_slot_input(chat_id: str, kind: SlotKind, slot: int, text: str) -> bool:
    """Write raw input to a logical slot, reviving its backing PTY first."""
    ts = ensure_live_slot(chat_id, kind, slot)
    if not ts or ts.finished:
        return False
    try:
        os.write(ts.master_fd, text.encode('utf-8', errors='replace'))
        ts.last_activity = time.time()
        return True
    except OSError:
        return False


def _resume_lock(chat_id: str, kind: SlotKind) -> threading.Lock:
    key = (chat_id, kind)
    with _resume_locks_guard:
        lock = _resume_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _resume_locks[key] = lock
        return lock


def resume_logical_slots(chat_id: str, kind: SlotKind = "agent") -> list[dict]:
    """Restore every logically-open slot for ``kind`` and return live states.

    Lifecycle parking is transparent to callers. This function intentionally
    pays the cold-start cost once, restoring the container and persisted shells
    as a unit; subsequent terminal operations then use already-live PTYs.
    """
    with _resume_lock(chat_id, kind):
        logical = [
            item for item in list_slots(chat_id)
            if item.get("kind") == kind and item.get("logical_open", not item.get("finished"))
        ]
        if not logical:
            return []
        if not docker.ensure_container_running(chat_id):
            raise RuntimeError(f"Could not start the workspace container for chat {chat_id}")
        states: list[dict] = []
        for item in logical:
            slot = int(item["slot"])
            revived = _revive_slot_if_lifecycled(chat_id, kind, slot)
            if revived is None or revived.finished:
                continue
            state = slot_state(chat_id, kind, slot) or {"slot": slot, "running": False, "pid": None}
            state["resumed"] = bool(revived.resume_notice)
            states.append(state)
        return sorted(states, key=lambda value: int(value["slot"]))


def encode_terminal_key(key: str, modifiers: list[str] | None = None) -> str:
    """Translate semantic keyboard actions into portable xterm/PTY input."""
    if not isinstance(key, str) or not key.strip():
        raise ValueError("key must be a non-empty key name")
    if modifiers is None:
        modifiers = []
    if not isinstance(modifiers, list) or any(not isinstance(item, str) for item in modifiers):
        raise ValueError("modifiers must be a list of key modifier names")
    normalized = {item.strip().upper() for item in modifiers}
    unsupported = normalized - {"CTRL", "ALT", "SHIFT", "META"}
    if unsupported:
        raise ValueError(f"Unsupported key modifier: {sorted(unsupported)[0]}")

    name = key.strip().upper()
    simple = {
        "ENTER": "\r", "RETURN": "\r", "TAB": "\t", "ESC": "\x1b",
        "ESCAPE": "\x1b", "BACKSPACE": "\x7f", "SPACE": " ",
    }
    arrows = {"UP": "A", "DOWN": "B", "RIGHT": "C", "LEFT": "D", "HOME": "H", "END": "F"}
    navigation = {"INSERT": "2", "DELETE": "3", "PAGE_UP": "5", "PAGE_DOWN": "6"}
    modifier_code = 1 + (1 if "SHIFT" in normalized else 0) + (2 if "ALT" in normalized else 0) + (4 if "CTRL" in normalized else 0) + (8 if "META" in normalized else 0)

    if name in arrows:
        return f"\x1b[1;{modifier_code}{arrows[name]}" if normalized else f"\x1b[{arrows[name]}"
    if name in navigation:
        return f"\x1b[{navigation[name]};{modifier_code}~" if normalized else f"\x1b[{navigation[name]}~"
    if name == "TAB" and normalized == {"SHIFT"}:
        return "\x1b[Z"
    if name in simple:
        if normalized - {"ALT", "META"}:
            raise ValueError(f"Unsupported modifier combination for {name}")
        value = simple[name]
        return "\x1b" + value if normalized else value
    if name.startswith("F") and name[1:].isdigit():
        number = int(name[1:])
        if 1 <= number <= 4:
            suffix = "PQRS"[number - 1]
            return f"\x1b[1;{modifier_code}{suffix}" if normalized else f"\x1bO{suffix}"
        function_codes = {5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24}
        if number in function_codes:
            code = function_codes[number]
            return f"\x1b[{code};{modifier_code}~" if normalized else f"\x1b[{code}~"
    if len(key) == 1 and key.isprintable():
        value = key.upper() if "SHIFT" in normalized else key
        if "CTRL" in normalized:
            character = key.upper()
            if not ("@" <= character <= "_"):
                raise ValueError(f"CTRL cannot modify key {key!r}")
            value = chr(ord(character) & 0x1f)
        if "ALT" in normalized or "META" in normalized:
            value = "\x1b" + value
        return value
    raise ValueError(f"Unsupported terminal key: {key}")


def read_slot_output(chat_id: str, kind: SlotKind, slot: int, lines: int = 50) -> str:
    """Return recent logical scrollback across live, parked, and server-restarted slots."""
    key = _slot_key(chat_id, kind, slot)
    ts = _slots.get(key)
    persisted = get_slot_scrollback(chat_id, kind, slot) or ""
    if not ts:
        split = _strip_lifecycle_notices(persisted).split('\n')
        return '\n'.join(split[-lines:])
    # A finished session has already been merged into persisted scrollback.  A
    # live replacement shell has only its new output there, so concatenate the
    # durable history with the live tail to make lifecycle reopening invisible.
    live = "" if ts.finished or ts.persisted else "".join(ts.output)
    full = _strip_lifecycle_notices(persisted + live)
    split = full.split('\n')
    return '\n'.join(split[-lines:])


def mirror_to_slot(chat_id: str, kind: SlotKind, slot: int, text: str):
    """Append text to a slot's output stream (for use_terminal mirroring)."""
    key = _slot_key(chat_id, kind, slot)
    ts = _slots.get(key)
    if ts and not ts.finished:
        ts.output.append(text)
        ts.last_activity = time.time()


async def stream_slot(chat_id: str, kind: SlotKind, slot: int) -> AsyncIterator[str]:
    """SSE stream for a specific terminal slot."""
    key = _slot_key(chat_id, kind, slot)
    ts = _slots.get(key)
    if not ts:
        yield "--- Slot not open ---\r\n"
        return
    sent = 0
    while True:
        chunks = ts.output[sent:]
        for c in chunks:
            yield c
        sent += len(chunks)
        if ts.finished:
            break
        await asyncio.sleep(0.05)


# ── Shell session (one per chat) ──────────────────────────────────────────────

@dataclass
class ShellSession:
    chat_id:   str
    proc:      object       # Popen
    master_fd: int
    output:    list         = field(default_factory=list)  # chunks for SSE
    finished:  bool         = False


_shells:    dict[str, ShellSession] = {}   # chat_id → ShellSession
_shell_lock = threading.Lock()


def _ensure_chat_dirs(chat_id: str):
    """Ensure host-side storage exists before starting a terminal."""
    cfg.chat_dir(chat_id)   # creates workspace/ and attachments/ subdirs
    cfg.SHARED_DIR.mkdir(parents=True, exist_ok=True)


def start_shell(chat_id: str) -> str:
    """Start (or return existing) persistent bash shell for this chat."""
    with _shell_lock:
        existing = _shells.get(chat_id)
        if existing and not existing.finished:
            # Return existing shell's pid from process registry
            for pid, mp in _processes.items():
                if mp.get('chat_id') == chat_id and mp.get('kind') == 'shell':
                    return pid
            # Shell exists but no pid registered — fall through to create one

    _ensure_chat_dirs(chat_id)

    master_fd, slave_fd = pty.openpty()

    # Set initial window size
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    except Exception:
        pass

    prefix = ['wsl'] if docker._is_windows() else []
    session_prefix = prefix + ['setsid', '--ctty'] if (docker._is_windows() or shutil.which('setsid')) else prefix
    workdir = docker.workspace_path(chat_id)
    shell_prefix = 'umask 000'
    proc = subprocess.Popen(
        session_prefix + [
            'docker', 'exec', '-it', *docker.terminal_exec_flags(chat_id, kind, slot),
            '-w', workdir,
            '-e', 'TERM=xterm-256color',
            '-e', 'COLORTERM=truecolor',
            docker.container_name(chat_id),
            '/bin/bash', '-c', f'{shell_prefix}; exec /bin/bash -i',
        ],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    shell = ShellSession(chat_id=chat_id, proc=proc, master_fd=master_fd)

    with _shell_lock:
        _shells[chat_id] = shell

    def _collect():
        try:
            while True:
                try:
                    data = os.read(master_fd, 4096)
                    if not data:
                        break
                    shell.output.append(data.decode('utf-8', errors='replace'))
                except OSError:
                    break
        finally:
            shell.finished = True
            try: os.close(master_fd)
            except OSError: pass

    threading.Thread(target=_collect, daemon=True).start()

    pid = _new_pid()
    _processes[pid] = {'kind': 'shell', 'chat_id': chat_id, 'shell': shell}
    return pid


def resize_shell(chat_id: str, cols: int, rows: int):
    import struct
    shell = _shells.get(chat_id)
    if shell and not shell.finished:
        try:
            fcntl.ioctl(shell.master_fd, termios.TIOCSWINSZ,
                        struct.pack('HHHH', rows, cols, 0, 0))
        except Exception:
            pass


def send_input(pid: str, text: str) -> bool:
    """Write raw keystrokes to the chat's shell PTY."""
    mp = _processes.get(pid, {})
    chat_id = mp.get('chat_id')
    if not chat_id:
        return False
    shell = _shells.get(chat_id)
    if not shell or shell.finished:
        return False
    try:
        os.write(shell.master_fd, text.encode('utf-8', errors='replace'))
        return True
    except OSError:
        return False


# ── Command execution (one-shot, piped) ───────────────────────────────────────

@dataclass
class CommandProcess:
    pid:      str
    cmd:      str
    chat_id:  str
    output:   list          = field(default_factory=list)  # captured lines
    finished: bool          = False
    exit_code: int          = 0
    detached: bool          = False
    detach_reason: str      = ""
    started_at: float       = field(default_factory=time.time)
    slot_key: tuple | None  = None


_processes: dict[str, dict] = {}   # pid → {'kind': ..., ...}
_commands:  dict[str, CommandProcess] = {}
_proc_lock = threading.Lock()


def use_terminal(chat_id: str, cmd: str, timeout: int = 180,
                background: bool = False) -> str:
    if not docker.container_running(chat_id):
        raise RuntimeError(f"Container for chat {chat_id} is not running.")

    _ensure_chat_dirs(chat_id)

    pid = _new_pid()
    cp  = CommandProcess(pid=pid, cmd=cmd, chat_id=chat_id)

    with _proc_lock:
        _commands[pid] = cp
        _processes[pid] = {'kind': 'command', 'chat_id': chat_id, 'cp': cp}

    prefix = ['wsl'] if docker._is_windows() else []
    proc = subprocess.Popen(
        prefix + [
            'docker', 'exec', '-i', *docker.workspace_exec_flags(chat_id),
            '-w', docker.workspace_path(chat_id),
            docker.container_name(chat_id),
            '/bin/bash', '-c', f'umask 000; {cmd}',
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )

    shell = _shells.get(chat_id)

    def _collect():
        import select
        start = time.time()
        # Write a header line to xterm so user sees the command
        if shell and not shell.finished:
            header = f"\r\n\x1b[2m$ {cmd}\x1b[0m\r\n"
            shell.output.append(header)
        try:
            while True:
                if cp.detached:
                    break
                if time.time() - start > timeout:
                    line = f"\r\n--- Timed out after {timeout}s ---\r\n"
                    cp.output.append(line)
                    if shell and not shell.finished:
                        shell.output.append(line)
                    break
                ready = select.select([proc.stdout], [], [], 0.1)[0]
                if ready:
                    line = proc.stdout.readline()
                    if line:
                        cp.output.append(line)
                        # Mirror to xterm
                        if shell and not shell.finished:
                            shell.output.append(line.replace('\n', '\r\n'))
                    elif proc.poll() is not None:
                        # Drain
                        rest = proc.stdout.read()
                        if rest:
                            cp.output.append(rest)
                            if shell and not shell.finished:
                                shell.output.append(rest.replace('\n', '\r\n'))
                        break
                elif proc.poll() is not None:
                    rest = proc.stdout.read()
                    if rest:
                        cp.output.append(rest)
                        if shell and not shell.finished:
                            shell.output.append(rest.replace('\n', '\r\n'))
                    break
        finally:
            try: proc.kill()
            except Exception: pass
            cp.exit_code = proc.poll() or 0
            cp.finished  = True
            # Nudge the real shell to reprint its prompt. The mirrored command
            # ran in a separate process, so bash-in-the-PTY doesn't know anything
            # happened and has nothing on-screen after our mirrored output.
            if shell and not shell.finished:
                try: os.write(shell.master_fd, b'\n')
                except OSError: pass

    threading.Thread(target=_collect, daemon=True).start()
    return pid


def use_terminal_in_slot(chat_id: str, kind: SlotKind, slot: int,
                        cmd: str, timeout: int | None = 180) -> str:
    """Run directly inside the slot's persistent, fully interactive PTY shell.

    If lifecycle management reaped the slot/container, the command itself is the
    demand signal that revives the same slot before execution.
    """
    _ensure_chat_dirs(chat_id)
    key = _slot_key(chat_id, kind, slot)
    ts = ensure_live_slot(chat_id, kind, slot)
    if ts is None or ts.finished:
        raise RuntimeError(f"Terminal {slot} is not open. Open or select a live terminal first.")
    if not docker.container_running(chat_id):
        raise RuntimeError(f"Container for chat {chat_id} is not running.")
    if ts.has_running or ts.active_command is not None:
        raise RuntimeError(
            f"Terminal {slot} already has a foreground process. Use send_input, "
            "type directly into its terminal, or open another terminal."
        )
    pid = _new_pid()
    cp = CommandProcess(pid=pid, cmd=cmd, chat_id=chat_id, slot_key=key)

    with _proc_lock:
        _commands[pid] = cp
        _processes[pid] = {'kind': 'command', 'chat_id': chat_id, 'cp': cp}

    ts.active_command = cp
    ts.last_command_pid = pid
    ts.has_running = True
    ts.capture_active = not ts.shell_integration
    wrapped = (
        "{\n" + cmd.rstrip('\n') + "\n}; __vulcan_command_status=$?; "
        + f"printf '\\033]777;vulcan-command;{pid};%s\\007' \"$__vulcan_command_status\"; "
        + "unset __vulcan_command_status\n"
    )
    try:
        os.write(ts.master_fd, wrapped.encode('utf-8', errors='replace'))
        ts.last_activity = time.time()
    except OSError as error:
        ts.active_command = None
        ts.has_running = False
        ts.capture_active = False
        cp.finished = True
        cp.exit_code = 1
        raise RuntimeError(f"Terminal {slot} is no longer connected") from error

    def _watch_timeout():
        deadline = time.monotonic() + max(timeout, 1)
        while not cp.finished and not ts.finished:
            if time.monotonic() >= deadline:
                cp.output.append(
                    f"\n--- Timed out after {timeout}s; the foreground process "
                    "remains active in the interactive terminal ---\n"
                )
                cp.detach_reason = "Command timed out; its interactive terminal remains open."
                cp.detached = True
                cp.finished = True
                return
            time.sleep(0.05)

    if timeout is not None:
        threading.Thread(target=_watch_timeout, daemon=True).start()
    return pid


def get_command(pid: str) -> Optional[CommandProcess]:
    return _commands.get(pid)


def detach_process(pid: str, reason: str = "") -> bool:
    cp = _commands.get(pid)
    if not cp or cp.finished:
        return False
    cp.detached      = True
    cp.detach_reason = reason
    cp.finished      = True
    return True


def kill_process(pid: str) -> bool:
    cp = _commands.get(pid)
    if cp and cp.slot_key:
        chat_id, kind, slot = cp.slot_key
        return send_slot_input(chat_id, kind, slot, '\x03')
    return detach_process(pid)


def get_full_output(pid: str) -> str:
    cp = _commands.get(pid)
    if not cp:
        return f"Unknown process: {pid}"
    return "".join(cp.output).strip()


# ── Wait tool ─────────────────────────────────────────────────────────────────

@dataclass
class WaitProcess:
    pid:          str
    chat_id:      str
    seconds:      float
    webhook_key:  str | None = None
    finished:     bool  = False
    detached:     bool  = False
    detach_reason: str  = ""
    wake_reason:  str | None = None
    webhook_method: str | None = None
    webhook_path: str | None = None
    started_at:   float = field(default_factory=time.time)


_waits: dict[str, WaitProcess] = {}
_wait_webhooks: dict[str, set[str]] = {}
_wait_webhooks_lock = threading.Lock()


def normalize_webhook_url(webhook_url: str) -> str:
    """Return the Vulcan webhook path used to wake a wait process."""
    value = str(webhook_url or "").strip()
    if not value:
        raise ValueError("webhook_url must be a non-empty URL or /webhook/... path.")
    parsed = urlsplit(value)
    if parsed.scheme and parsed.scheme not in ("http", "https"):
        raise ValueError("webhook_url must use http or https.")
    path = parsed.path or value
    if not path.startswith("/webhook/") or path == "/webhook/":
        raise ValueError("webhook_url must point to /webhook/<name> on this Vulcan server.")
    return path.rstrip("/")


def _unregister_wait_webhook(wp: WaitProcess) -> None:
    if not wp.webhook_key:
        return
    with _wait_webhooks_lock:
        pids = _wait_webhooks.get(wp.webhook_key)
        if not pids:
            return
        pids.discard(wp.pid)
        if not pids:
            _wait_webhooks.pop(wp.webhook_key, None)


def start_wait(chat_id: str, seconds: float, webhook_url: str | None = None) -> str:
    pid = _new_pid()
    webhook_key = normalize_webhook_url(webhook_url) if webhook_url is not None else None
    wp  = WaitProcess(pid=pid, chat_id=chat_id, seconds=seconds, webhook_key=webhook_key)
    _waits[pid] = wp
    _processes[pid] = {'kind': 'wait', 'chat_id': chat_id, 'wp': wp}
    if webhook_key:
        with _wait_webhooks_lock:
            _wait_webhooks.setdefault(webhook_key, set()).add(pid)

    def _wait():
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if wp.detached or wp.finished:
                break
            time.sleep(0.05)
        if not wp.finished and not wp.detached:
            wp.wake_reason = "timeout"
            wp.finished = True
        _unregister_wait_webhook(wp)

    threading.Thread(target=_wait, daemon=True).start()
    return pid


def trigger_webhook(path: str, method: str = "POST") -> int:
    """Wake all active waits registered for the exact /webhook/... path."""
    key = str(path or "").rstrip("/")
    with _wait_webhooks_lock:
        pids = list(_wait_webhooks.get(key, set()))
    triggered = 0
    for pid in pids:
        wp = _waits.get(pid)
        if not wp or wp.finished or wp.detached:
            continue
        wp.webhook_method = str(method or "POST").upper()
        wp.webhook_path = key
        wp.wake_reason = "webhook"
        wp.finished = True
        _unregister_wait_webhook(wp)
        triggered += 1
    return triggered


def get_wait(pid: str) -> Optional[WaitProcess]:
    return _waits.get(pid)


def detach_wait(pid: str, reason: str = "") -> bool:
    wp = _waits.get(pid)
    if not wp or wp.finished:
        return False
    wp.detached      = True
    wp.detach_reason = reason
    wp.finished      = True
    _unregister_wait_webhook(wp)
    return True


# ── SSE streaming ─────────────────────────────────────────────────────────────

async def stream_shell(chat_id: str) -> AsyncIterator[str]:
    """Stream all PTY output for a chat's shell (user + command mirrors)."""
    shell = _shells.get(chat_id)
    if not shell:
        yield "--- Shell not started ---\r\n"
        return
    sent = 0
    while True:
        chunks = shell.output[sent:]
        for c in chunks:
            yield c
        sent += len(chunks)
        if shell.finished:
            break
        await asyncio.sleep(0.05)


async def stream_command(pid: str) -> AsyncIterator[str]:
    """Stream output for a specific command (for tool result polling)."""
    cp = _commands.get(pid)
    if not cp:
        yield f"--- Unknown command: {pid} ---\n"
        return
    sent = 0
    while True:
        lines = cp.output[sent:]
        for l in lines:
            yield l
        sent += len(lines)
        if cp.finished or cp.detached:
            if cp.detached:
                reason = cp.detach_reason.strip()
                msg = f"Detached by user. Reason: {reason}" if reason else "Detached by user."
                yield f"\n--- {msg} ---\n"
            break
        await asyncio.sleep(0.05)


# ── Cleanup ───────────────────────────────────────────────────────────────────

def cleanup_old(max_age: int = 3600):
    now = time.time()
    for pid in list(_commands):
        cp = _commands[pid]
        if cp.finished and (now - cp.started_at) > max_age:
            del _commands[pid]
            _processes.pop(pid, None)
