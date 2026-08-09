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
import os
import pty
import struct
import subprocess
import termios
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional, AsyncIterator, Literal

from vulcan import docker
from vulcan import config as cfg


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
    has_running:  bool             = False   # True while a mirrored run_command targets this slot
    prompt_busy:   bool             = False   # True after shell command start, until prompt returns
    marker_pending: str             = ''      # partial OSC marker split across PTY reads

    @property
    def is_busy(self) -> bool:
        return self.has_running or self.prompt_busy

    @property
    def slot_id(self) -> str:
        return f"{self.chat_id}:{self.kind}:{self.slot}"


# (chat_id, kind, slot) → TerminalSlot
_slots:      dict[tuple, TerminalSlot] = {}
_slots_lock = threading.Lock()

# Per-chat scrollback storage: (chat_id, kind, slot) → serialized string
_scrollbacks: dict[tuple, str] = {}


def _slot_key(chat_id: str, kind: SlotKind, slot: int) -> tuple:
    return (chat_id, kind, slot)


def _slots_file(chat_id: str) -> 'Path':
    from pathlib import Path
    if chat_id == docker.GLOBAL_CHAT_ID:
        cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        return cfg.CONFIG_DIR / "global_terminal_slots.json"
    return cfg.chat_dir(chat_id) / "terminal_slots.json"


def _save_slot_meta(chat_id: str):
    """Persist slot metadata (scrollback, open slots) to disk."""
    data = {}
    for (cid, kind, slot), scrollback in _scrollbacks.items():
        if cid != chat_id:
            continue
        key = f"{kind}:{slot}"
        data[key] = {"scrollback": scrollback}
    try:
        _slots_file(chat_id).write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass


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
    if key in _scrollbacks:
        return _scrollbacks[key]
    # Try disk
    meta = _load_slot_meta(chat_id)
    entry = meta.get(f"{kind}:{slot}")
    if entry:
        return entry.get("scrollback")
    return None


def save_slot_scrollback(chat_id: str, kind: SlotKind, slot: int, scrollback: str):
    """Save serialized xterm scrollback for a slot."""
    key = _slot_key(chat_id, kind, slot)
    _scrollbacks[key] = scrollback
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
    """List all open slots for a chat."""
    result = []
    with _slots_lock:
        for (cid, kind, slot), ts in _slots.items():
            if cid != chat_id:
                continue
            result.append({
                "kind": kind,
                "slot": slot,
                "finished": ts.finished,
                "has_running": ts.is_busy,
                "last_activity": ts.last_activity,
            })
    return sorted(result, key=lambda x: (x["kind"], x["slot"]))


def _next_slot(chat_id: str, kind: SlotKind) -> int | None:
    """Return the lowest available slot number (1-3), or None if full."""
    used = {
        slot for (cid, k, slot) in _slots
        if cid == chat_id and k == kind and not _slots[(cid, k, slot)].finished
    }
    for n in range(1, SLOT_MAX + 1):
        if n not in used:
            return n
    return None


def _install_slot_shell_integration(chat_id: str, kind: SlotKind, slot: int) -> str:
    """Create a bash rcfile in the backing container and return its path.

    Bash expands PS0 immediately before executing an interactive command, while
    PS1 is expanded when the shell has regained control and is ready for another
    command. Private OSC markers in those expansions give us exact busy/idle
    transitions without changing the visible prompt.
    """
    safe_chat = ''.join(c if c.isalnum() or c in '-_' else '_' for c in chat_id)
    rc_path = f"/tmp/vulcan-{safe_chat}-{kind}-{slot}.bashrc"
    rc = r"""# Vulcan terminal shell integration
[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -r ~/.bashrc ] && . ~/.bashrc
PS0=$'\033]777;vulcan-terminal;busy\007'"${PS0-}"
PS1=$'\033]777;vulcan-terminal;idle\007'"${PS1-\u@\h:\w\$ }"
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
    """Consume private shell-integration markers and return visible PTY text."""
    data = ts.marker_pending + chunk
    ts.marker_pending = ''
    visible: list[str] = []

    while data:
        found = []
        for marker in _ACTIVITY_MARKERS:
            pos = data.find(marker)
            if pos >= 0:
                found.append((pos, marker))

        if found:
            pos, marker = min(found, key=lambda pair: pair[0])
            visible.append(data[:pos])
            ts.prompt_busy = marker == _ACTIVITY_BUSY_MARKER
            ts.last_activity = time.time()
            data = data[pos + len(marker):]
            continue

        # PTY reads can split an OSC marker. Retain the longest trailing suffix
        # that could be the start of either marker and emit everything else.
        keep = 0
        for marker in _ACTIVITY_MARKERS:
            max_n = min(len(data), len(marker) - 1)
            for n in range(max_n, 0, -1):
                if data.endswith(marker[:n]):
                    keep = max(keep, n)
                    break
        if keep:
            visible.append(data[:-keep])
            ts.marker_pending = data[-keep:]
        else:
            visible.append(data)
        break

    return ''.join(visible)


def _start_slot_proc(chat_id: str, kind: SlotKind, slot: int) -> TerminalSlot:
    """Spawn a new PTY bash session for a slot."""
    master_fd, slave_fd = pty.openpty()
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    except Exception:
        pass

    session_var = f"VULCAN_SESSION={kind}:{slot}"
    prefix = ['wsl'] if docker._is_windows() else []
    workdir = docker.workspace_path(chat_id)
    shell_prefix = 'umask 022' if chat_id == docker.GLOBAL_CHAT_ID else 'umask 000'
    rc_path = _install_slot_shell_integration(chat_id, kind, slot)
    interactive_shell = ['/bin/bash', '--rcfile', rc_path, '-i'] if rc_path else ['/bin/bash', '-i']
    proc = subprocess.Popen(
        prefix + [
            'docker', 'exec', '-it',
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
        preexec_fn=_make_controlling_tty,
    )
    os.close(slave_fd)

    ts = TerminalSlot(chat_id=chat_id, kind=kind, slot=slot, proc=proc, master_fd=master_fd)

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
            ts.finished = True
            try:
                os.close(master_fd)
            except OSError:
                pass

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


def open_slot(chat_id: str, kind: SlotKind) -> int:
    """
    Open a new terminal slot of the given kind for this chat.
    Returns the slot number (1-3).
    Raises ValueError if the maximum number of slots is already open.
    """
    _ensure_chat_dirs(chat_id)
    with _slots_lock:
        slot = _next_slot(chat_id, kind)
        if slot is None:
            raise ValueError(
                f"Maximum of {SLOT_MAX} {kind} terminals already open. "
                f"Close an existing terminal with close_terminal(slot) before opening a new one."
            )
        ts = _start_slot_proc(chat_id, kind, slot)
        _slots[_slot_key(chat_id, kind, slot)] = ts
    return slot


def close_slot(chat_id: str, kind: SlotKind, slot: int, reason: str = 'explicit'):
    """Close a terminal slot, killing the PTY immediately."""
    key = _slot_key(chat_id, kind, slot)
    with _slots_lock:
        ts = _slots.get(key)
        if not ts or ts.finished:
            return
        ts.finished = True
        try:
            ts.proc.kill()
        except Exception:
            pass
        try:
            os.close(ts.master_fd)
        except OSError:
            pass
        # Append a closing notice to the output stream
        notice = f"\r\n\x1b[2m[Terminal closed{' due to inactivity' if reason == 'inactivity' else ''}]\x1b[0m\r\n"
        ts.output.append(notice)


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
        fcntl.ioctl(ts.master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except Exception:
        pass
    try:
        docker.run_docker([
            "exec", docker.container_name(chat_id),
            "bash", "-c", "pkill -WINCH bash 2>/dev/null || true",
        ], capture_output=True)
    except Exception:
        pass


def send_slot_input(chat_id: str, kind: SlotKind, slot: int, text: str) -> bool:
    """Write raw input to a slot's PTY."""
    key = _slot_key(chat_id, kind, slot)
    ts = _slots.get(key)
    if not ts or ts.finished:
        return False
    try:
        os.write(ts.master_fd, text.encode('utf-8', errors='replace'))
        ts.last_activity = time.time()
        return True
    except OSError:
        return False


def read_slot_output(chat_id: str, kind: SlotKind, slot: int, lines: int = 50) -> str:
    """Return the last N lines of output from a slot."""
    key = _slot_key(chat_id, kind, slot)
    ts = _slots.get(key)
    if not ts:
        return ""
    # Join all output and split into lines, return last N
    full = "".join(ts.output)
    split = full.split('\n')
    return '\n'.join(split[-lines:])


def mirror_to_slot(chat_id: str, kind: SlotKind, slot: int, text: str):
    """Append text to a slot's output stream (for run_command mirroring)."""
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
    if chat_id == docker.GLOBAL_CHAT_ID:
        cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        return
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
    workdir = docker.workspace_path(chat_id)
    shell_prefix = 'umask 022' if chat_id == docker.GLOBAL_CHAT_ID else 'umask 000'
    proc = subprocess.Popen(
        prefix + [
            'docker', 'exec', '-it',
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
        preexec_fn=_make_controlling_tty,
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
        # TIOCSWINSZ delivers SIGWINCH to the PTY's direct child (docker exec),
        # but it may not propagate through into the bwrap/bash process. Send it
        # explicitly so readline redraws the current line at the new width.
        try:
            docker.run_docker([
                "exec", docker.container_name(chat_id),
                "bash", "-c",
                "pkill -WINCH bash 2>/dev/null || true",
            ], capture_output=True)
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


_processes: dict[str, dict] = {}   # pid → {'kind': ..., ...}
_commands:  dict[str, CommandProcess] = {}
_proc_lock = threading.Lock()


def run_command(chat_id: str, cmd: str, timeout: int = 180,
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
            'docker', 'exec', '-i',
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


def run_command_in_slot(chat_id: str, kind: SlotKind, slot: int,
                        cmd: str, timeout: int = 180) -> str:
    """
    Run a command and mirror its output to a specific terminal slot.
    Used by agent tool calls that target a focused slot.
    """
    if not docker.container_running(chat_id):
        raise RuntimeError(f"Container for chat {chat_id} is not running.")

    _ensure_chat_dirs(chat_id)

    pid = _new_pid()
    cp  = CommandProcess(pid=pid, cmd=cmd, chat_id=chat_id)

    with _proc_lock:
        _commands[pid] = cp
        _processes[pid] = {'kind': 'command', 'chat_id': chat_id, 'cp': cp}

    # Mark slot as having a running process (suppresses inactivity close)
    key = _slot_key(chat_id, kind, slot)
    ts = _slots.get(key)
    if ts and not ts.finished:
        ts.has_running = True

    prefix = ['wsl'] if docker._is_windows() else []
    proc = subprocess.Popen(
        prefix + [
            'docker', 'exec', '-i',
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

    def _collect():
        import select
        start = time.time()
        if ts and not ts.finished:
            header = f"\r\n\x1b[2m$ {cmd}\x1b[0m\r\n"
            mirror_to_slot(chat_id, kind, slot, header)
        try:
            while True:
                if cp.detached:
                    break
                if time.time() - start > timeout:
                    line = f"\r\n--- Timed out after {timeout}s ---\r\n"
                    cp.output.append(line)
                    mirror_to_slot(chat_id, kind, slot, line)
                    break
                ready = select.select([proc.stdout], [], [], 0.1)[0]
                if ready:
                    line = proc.stdout.readline()
                    if line:
                        cp.output.append(line)
                        mirror_to_slot(chat_id, kind, slot, line.replace('\n', '\r\n'))
                    elif proc.poll() is not None:
                        rest = proc.stdout.read()
                        if rest:
                            cp.output.append(rest)
                            mirror_to_slot(chat_id, kind, slot, rest.replace('\n', '\r\n'))
                        break
                elif proc.poll() is not None:
                    rest = proc.stdout.read()
                    if rest:
                        cp.output.append(rest)
                        mirror_to_slot(chat_id, kind, slot, rest.replace('\n', '\r\n'))
                    break
        finally:
            try:
                proc.kill()
            except Exception:
                pass
            cp.exit_code = proc.poll() or 0
            cp.finished  = True
            if ts and not ts.finished:
                ts.has_running = False
                ts.last_activity = time.time()

    threading.Thread(target=_collect, daemon=True).start()
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
    finished:     bool  = False
    detached:     bool  = False
    detach_reason: str  = ""
    started_at:   float = field(default_factory=time.time)


_waits: dict[str, WaitProcess] = {}


def start_wait(chat_id: str, seconds: float) -> str:
    pid = _new_pid()
    wp  = WaitProcess(pid=pid, chat_id=chat_id, seconds=seconds)
    _waits[pid] = wp
    _processes[pid] = {'kind': 'wait', 'chat_id': chat_id, 'wp': wp}

    def _wait():
        start = time.time()
        while time.time() - start < seconds:
            if wp.detached:
                break
            time.sleep(0.1)
        wp.finished = True

    threading.Thread(target=_wait, daemon=True).start()
    return pid


def get_wait(pid: str) -> Optional[WaitProcess]:
    return _waits.get(pid)


def detach_wait(pid: str, reason: str = "") -> bool:
    wp = _waits.get(pid)
    if not wp or wp.finished:
        return False
    wp.detached      = True
    wp.detach_reason = reason
    wp.finished      = True
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
