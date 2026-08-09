"""
vulcan/workspace.py — Workspace file operations, git management, and snapshots

All file paths are relative to the chat's workspace/ subdirectory:
  ~/.vulcan/chats/<chat-uuid>/workspace/

Git:
  Each chat/<uuid>/ directory is a git repo whose working tree is workspace/.
  It lives on the host, outside the container. Vulcan is the only committer.
  Commit triggers:
    - Every 5 minutes if the working tree is dirty (auto-commit)
    - User saves from Monaco (Ctrl+S)
    - Before a nuke (to record final state)
  Commit message conventions:
    [auto] <summary>  — timed dirty-check commits
    [user] <summary>  — user save from editor

  environment.json is also tracked by git (it lives at the chat/<uuid>/ level,
  one level above workspace/, but is explicitly added to each commit).

Snapshots:
  Lightweight VS Code-style local snapshots stored in:
    ~/.vulcan/snapshots/<chat-uuid>/<file-stem>/<timestamp>.json
  Used for dense in-between history. Never committed to git unless explicitly.
"""

import base64
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from vulcan import config as cfg


# ── Path helpers ──────────────────────────────────────────────────────────────

def _chat_path(chat_id: str, relative_path: str) -> Path:
    """Resolve a relative path within a chat's workspace/ subdir, preventing traversal."""
    base = cfg.chat_workspace_dir(chat_id).resolve()
    full = (base / relative_path).resolve()
    if not str(full).startswith(str(base)):
        raise ValueError(f"Path traversal denied: {relative_path}")
    return full


def _ensure_git(chat_id: str):
    """
    Initialize git repo in chat/<uuid>/ if not already initialized.
    The repo tracks workspace/ and environment.json.
    attachments/ is excluded via .gitignore.
    """
    chat = cfg.chat_dir(chat_id)
    if not (chat / ".git").exists():
        subprocess.run(["git", "init"], cwd=chat, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "vulcan@localhost"],
            cwd=chat, capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Vulcan"],
            cwd=chat, capture_output=True,
        )
        # Write .gitignore — exclude attachments/
        gitignore = chat / ".gitignore"
        if not gitignore.exists():
            gitignore.write_text("attachments/\n", encoding="utf-8")


# ── File operations ───────────────────────────────────────────────────────────

def read_file(chat_id: str, path: str) -> str:
    """Read a text file from the chat workspace."""
    full = _chat_path(chat_id, path)
    if not full.exists():
        raise FileNotFoundError(f"File not found: {path}")
    return full.read_text(encoding="utf-8", errors="replace")


def read_file_base64(chat_id: str, path: str) -> tuple[str, str]:
    """
    Read a binary file and return (base64_string, mime_type).
    Used by view_file for images.
    """
    import mimetypes
    full = _chat_path(chat_id, path)
    if not full.exists():
        raise FileNotFoundError(f"File not found: {path}")
    data = full.read_bytes()
    b64  = base64.b64encode(data).decode("ascii")
    mime, _ = mimetypes.guess_type(str(full))
    mime = mime or "application/octet-stream"
    return b64, mime


def write_file(chat_id: str, path: str, content: str):
    """Write a text file to the chat workspace, creating parent dirs as needed."""
    full = _chat_path(chat_id, path)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def create_directory(chat_id: str, path: str):
    """Create a directory inside the chat workspace."""
    full = _chat_path(chat_id, path)
    if full.exists():
        raise ValueError(f"Path already exists: {path}")
    full.mkdir(parents=True, exist_ok=False)


def edit_file(chat_id: str, path: str, edits: list[dict]) -> dict:
    """Apply one or more anchored line-range replacements safely.

    Each edit is {start_line, end_line, anchor, replacement}. Line numbers are
    interpreted against the original file. Edits are applied top-to-bottom and
    adjusted for line-count changes made by earlier edits. The anchor may occur
    anywhere inside the requested range; it is not pinned to an absolute line.
    """
    full = _chat_path(chat_id, path)
    if not full.exists():
        raise FileNotFoundError(f"File not found: {path}")
    if not isinstance(edits, list) or not edits:
        raise ValueError("edits must be a non-empty list")

    lines = full.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
    original_total = len(lines)

    normalized = []
    for i, edit in enumerate(edits):
        try:
            start = int(edit["start_line"])
            end = int(edit["end_line"])
            anchor = str(edit["anchor"])
            replacement = str(edit.get("replacement", ""))
        except (KeyError, TypeError, ValueError) as e:
            raise ValueError(f"Edit {i + 1} is missing or has invalid fields") from e
        if start < 1 or end < start or end > original_total:
            raise ValueError(f"Edit {i + 1} range {start}–{end} is out of bounds (file has {original_total} lines).")
        if not anchor:
            raise ValueError(f"Edit {i + 1} anchor must not be empty")
        normalized.append((start, end, anchor, replacement, i))

    normalized.sort(key=lambda x: (x[0], x[1]))
    for prev, cur in zip(normalized, normalized[1:]):
        if cur[0] <= prev[1]:
            raise ValueError(f"Edit ranges overlap: {prev[0]}–{prev[1]} and {cur[0]}–{cur[1]}")

    offset = 0
    results = [None] * len(normalized)
    for start, end, anchor, replacement, original_index in normalized:
        adj_start = start + offset
        adj_end = end + offset
        current_slice = lines[adj_start - 1:adj_end]
        anchor_line = next((adj_start + i for i, line in enumerate(current_slice) if anchor in line.rstrip("\r\n")), None)
        if anchor_line is None:
            excerpt = ''.join(current_slice).strip()
            raise ValueError(
                f"Edit {original_index + 1}: anchor {anchor!r} was not found in current range "
                f"{adj_start}–{adj_end}. Re-read or use find_in_file and retry. Range content: {excerpt!r}"
            )

        replacement_lines = replacement.splitlines(keepends=True)
        if replacement_lines and not replacement_lines[-1].endswith("\n"):
            replacement_lines[-1] += "\n"
        old_count = adj_end - adj_start + 1
        lines = lines[:adj_start - 1] + replacement_lines + lines[adj_end:]
        new_count = len(replacement_lines)
        new_start = adj_start
        new_end = adj_start + max(new_count - 1, 0)
        offset += new_count - old_count
        results[original_index] = {
            "anchor": "found",
            "new_start": new_start,
            "new_end": new_end,
        }

    full.write_text("".join(lines), encoding="utf-8")
    return {"ok": True, "edits": results}


def find_in_file(chat_id: str, path: str, query: str) -> list[dict]:
    """Return every line containing query, with 1-indexed line numbers."""
    full = _chat_path(chat_id, path)
    if not full.exists():
        raise FileNotFoundError(f"File not found: {path}")
    if not query:
        raise ValueError("query must not be empty")
    lines = full.read_text(encoding="utf-8", errors="replace").splitlines()
    return [{"line": i, "content": line} for i, line in enumerate(lines, 1) if query in line]


def list_files(chat_id: str) -> list[str]:
    """
    List all files and directories in the chat's workspace/ subdir recursively.
    Returns paths relative to workspace/. Directories have a trailing '/'.
    """
    base = cfg.chat_workspace_dir(chat_id)
    results = []
    for f in base.rglob("*"):
        rel = str(f.relative_to(base))
        if f.is_dir():
            results.append(rel + "/")
        else:
            results.append(rel)
    return sorted(results)



def prepare_upload_destination(chat_id: str, filename: str, workspace_path: str | None = None) -> tuple[Path, str, bool]:
    """Resolve a safe final destination for a streamed upload.

    Returns (absolute_path, public_path, is_workspace). Workspace uploads refuse
    to overwrite existing content; attachment uploads preserve the historical
    behavior of replacing an attachment with the same basename.
    """
    if workspace_path:
        clean = str(workspace_path).strip().replace('\\', '/').lstrip('/')
        if not clean or clean.endswith('/'):
            raise ValueError('A workspace upload requires a file path')
        dest = _chat_path(chat_id, clean)
        if dest.exists():
            raise FileExistsError(f'Path already exists: {clean}')
        dest.parent.mkdir(parents=True, exist_ok=True)
        return dest, clean, True

    safe_name = Path(str(filename or 'attachment')).name
    if not safe_name or safe_name in {'.', '..'}:
        safe_name = 'attachment'
    attachments = cfg.chat_attachments_dir(chat_id)
    attachments.mkdir(parents=True, exist_ok=True)
    return attachments / safe_name, f'/attachments/{safe_name}', False

def save_attachment(chat_id: str, filename: str, data: bytes) -> str:
    """
    Save an uploaded file to the chat's attachments/ directory.
    Returns the filename (attachments are accessed at /attachments/<filename> in container).
    """
    attachments = cfg.chat_attachments_dir(chat_id)
    attachments.mkdir(exist_ok=True)
    dest = attachments / filename
    dest.write_bytes(data)
    return filename


def save_workspace_upload(chat_id: str, path: str, data: bytes) -> str:
    """Save uploaded binary data at an explicit workspace-relative path.

    Refuses to overwrite an existing file or directory; drag/drop uploads should
    never silently replace workspace content.
    """
    clean = str(path).strip().replace('\\', '/').lstrip('/')
    if not clean or clean.endswith('/'):
        raise ValueError('A workspace upload requires a file path')
    dest = _chat_path(chat_id, clean)
    if dest.exists():
        raise FileExistsError(f'Path already exists: {clean}')
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return clean


# ── Git operations ────────────────────────────────────────────────────────────

def git_commit(chat_id: str, message: str) -> Optional[str]:
    """
    Commit all current changes in workspace/ plus environment.json.
    Returns the commit hash, or None if nothing to commit.

    Commit message conventions (enforced by callers):
      [auto] <summary>  — timed dirty-check commits
      [user] <summary>  — user save from editor
    """
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)

    # Stage workspace/ contents and environment.json
    subprocess.run(["git", "add", "workspace/"], cwd=chat, capture_output=True)
    env_json = cfg.chat_environment_json(chat_id)
    if env_json.exists():
        subprocess.run(
            ["git", "add", "environment.json"],
            cwd=chat, capture_output=True,
        )

    # Check if there's anything to commit
    result = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=chat,
        capture_output=True,
    )
    if result.returncode == 0:
        return None  # Nothing staged

    # Commit
    result = subprocess.run(
        ["git", "commit", "-m", message],
        cwd=chat,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None

    # Return hash
    hash_result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=chat,
        capture_output=True,
        text=True,
    )
    return hash_result.stdout.strip()


def git_log(chat_id: str, path: Optional[str] = None) -> list[dict]:
    """
    Return git log for the chat workspace, optionally filtered to a path.
    Returns list of { hash, shortHash, message, author, timestamp }.
    """
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)

    args = [
        "git", "log",
        "--format=%H\x1f%h\x1f%s\x1f%an\x1f%aI",
    ]
    if path:
        args += ["--", path]

    result = subprocess.run(args, cwd=chat, capture_output=True, text=True)
    commits = []
    for line in result.stdout.strip().splitlines():
        if not line.strip():
            continue
        parts = line.split("\x1f")
        if len(parts) < 5:
            continue
        full_hash, short_hash, message, author_name, timestamp = parts
        # Derive author from commit message prefix convention
        if message.startswith("[auto]"):
            author = "auto"
        elif message.startswith("[user]"):
            author = "user"
        else:
            author = "auto"  # fallback
        commits.append({
            "hash":      full_hash,
            "shortHash": short_hash,
            "message":   message,
            "author":    author,
            "timestamp": timestamp,
        })
    return commits


def git_show(chat_id: str, commit_hash: str, path: str) -> str:
    """Return file content at a specific git commit."""
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)
    result = subprocess.run(
        ["git", "show", f"{commit_hash}:{path}"],
        cwd=chat,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise FileNotFoundError(f"File {path} not found at commit {commit_hash}")
    return result.stdout


def git_restore(chat_id: str, commit_hash: str) -> str:
    """
    Restore the entire workspace to a specific commit.
    First commits current state, then checks out the target.
    Returns the new HEAD hash.
    """
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)

    # Commit current state before restoring
    git_commit(chat_id, "[auto] pre-restore snapshot")

    # Checkout target commit files
    subprocess.run(
        ["git", "checkout", commit_hash, "--", "."],
        cwd=chat,
        capture_output=True,
    )

    # Commit the restore
    new_hash = git_commit(chat_id, f"[user] restored workspace to {commit_hash[:8]}")
    return new_hash or commit_hash


def has_changed_since_last_commit(chat_id: str, path: str) -> bool:
    """
    Diff the file against HEAD. Returns True if the file has changed.
    Used to avoid creating empty git commits.
    """
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)
    full = _chat_path(chat_id, path)

    if not full.exists():
        return False

    result = subprocess.run(
        ["git", "diff", "HEAD", "--", path],
        cwd=chat,
        capture_output=True,
        text=True,
    )
    # Also check if file is untracked (new file)
    ls_result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", path],
        cwd=chat,
        capture_output=True,
    )
    is_untracked = ls_result.returncode != 0
    return bool(result.stdout.strip()) or is_untracked


def git_commit_auto(chat_id: str, summary: str) -> Optional[str]:
    """Timed dirty-check commit. No-ops if nothing changed."""
    return git_commit(chat_id, f"[auto] {summary}")


def git_commit_user(chat_id: str, summary: str) -> Optional[str]:
    """User-triggered commit (e.g. Ctrl+S in editor)."""
    return git_commit(chat_id, f"[user] {summary}")


def pre_nuke_commit(chat_id: str) -> Optional[str]:
    """
    Record final workspace state before a nuke.
    Called by the nuke flow before wiping workspace/ and environment.json.
    """
    return git_commit(chat_id, "[auto] pre-nuke snapshot")


def present_file(chat_id: str, path: str) -> Optional[str]:
    """
    Called when agent presents a file. Commits the current workspace state.
    Returns the commit hash.
    """
    filename = Path(path).name
    return git_commit_auto(chat_id, f"agent presented {filename}")


# ── Snapshots ─────────────────────────────────────────────────────────────────

def save_snapshot(chat_id: str, path: str) -> str:
    """
    Save a local snapshot of a file (not a git commit).
    Returns the snapshot ID (timestamp-based).
    """
    try:
        content = read_file(chat_id, path)
    except FileNotFoundError:
        return ""

    file_stem = Path(path).stem + "_" + Path(path).suffix.lstrip(".")
    snap_dir  = cfg.snapshot_dir(chat_id, file_stem)

    snapshot_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    snap_file   = snap_dir / f"{snapshot_id}.json"

    snap_file.write_text(json.dumps({
        "id":        snapshot_id,
        "path":      path,
        "content":   content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source":    "user",
    }), encoding="utf-8")

    return snapshot_id


def list_snapshots(chat_id: str, path: str) -> list[dict]:
    """List all local snapshots for a file, newest first."""
    file_stem = Path(path).stem + "_" + Path(path).suffix.lstrip(".")
    snap_dir  = cfg.snapshot_dir(chat_id, file_stem)

    snapshots = []
    for f in sorted(snap_dir.glob("*.json"), reverse=True):
        try:
            data = json.loads(f.read_text())
            snapshots.append({
                "id":        data["id"],
                "path":      data["path"],
                "timestamp": data["timestamp"],
                "source":    data.get("source", "user"),
            })
        except Exception:
            continue
    return snapshots


def get_snapshot_content(chat_id: str, snapshot_id: str, path: str) -> str:
    """Return file content from a specific snapshot."""
    file_stem = Path(path).stem + "_" + Path(path).suffix.lstrip(".")
    snap_dir  = cfg.snapshot_dir(chat_id, file_stem)
    snap_file = snap_dir / f"{snapshot_id}.json"

    if not snap_file.exists():
        raise FileNotFoundError(f"Snapshot {snapshot_id} not found")

    data = json.loads(snap_file.read_text())
    return data["content"]


# ── Workspace management ──────────────────────────────────────────────────────

def list_workspaces() -> list[dict]:
    """List all chat workspace directories with metadata."""
    results = []
    if not cfg.CHATS_DIR.exists():
        return results

    for d in sorted(cfg.CHATS_DIR.iterdir()):
        if not d.is_dir():
            continue
        try:
            size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
            mtime = max(
                (f.stat().st_mtime for f in d.rglob("*") if f.is_file()),
                default=d.stat().st_mtime,
            )
            results.append({
                "chatId":       d.name,
                "sizeBytes":    size,
                "lastModified": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
            })
        except Exception:
            continue
    return results


def delete_workspace(chat_id: str):
    """Delete a chat workspace directory and its snapshots."""
    import shutil
    chat = cfg.CHATS_DIR / chat_id
    if chat.exists():
        shutil.rmtree(chat)
    snap = cfg.SNAPSHOTS_DIR / chat_id
    if snap.exists():
        shutil.rmtree(snap)


def rename_path(chat_id: str, from_path: str, to_path: str):
    """
    Rename/move a file or directory within the chat workspace.
    Both paths are relative to workspace/.
    """
    src = _chat_path(chat_id, from_path)
    dst = _chat_path(chat_id, to_path)
    if not src.exists():
        raise FileNotFoundError(f"Not found: {from_path}")
    if dst.exists():
        raise ValueError(f"Destination already exists: {to_path}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)


def delete_path(chat_id: str, path: str):
    """
    Delete a file or directory from the chat workspace.
    path is relative to workspace/.
    """
    import shutil
    full = _chat_path(chat_id, path)
    if not full.exists():
        raise FileNotFoundError(f"Not found: {path}")
    if full.is_dir():
        shutil.rmtree(full)
    else:
        full.unlink()


def zip_folder(chat_id: str, path: str) -> bytes:
    """
    Zip a directory within the chat workspace and return the raw zip bytes.
    path is relative to workspace/.
    """
    import io
    import zipfile
    full = _chat_path(chat_id, path)
    if not full.exists():
        raise FileNotFoundError(f"Not found: {path}")
    if not full.is_dir():
        raise ValueError(f"Not a directory: {path}")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in full.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(full))
    return buf.getvalue()


def export_workspace_item(chat_id: str, path: str) -> tuple[bytes, str, str]:
    """Return a workspace item for client-side native export.

    Files are returned byte-for-byte with their original basename. Directories are
    packaged as a ZIP archive named ``<folder>.zip``.
    """
    import mimetypes

    clean = str(path).strip().replace('\\', '/').rstrip('/')
    if not clean:
        raise ValueError('A workspace export requires a path')
    full = _chat_path(chat_id, clean)
    if not full.exists():
        raise FileNotFoundError(f"Not found: {path}")

    if full.is_dir():
        return zip_folder(chat_id, clean), f"{full.name}.zip", 'application/zip'

    mime, _ = mimetypes.guess_type(str(full))
    return full.read_bytes(), full.name, mime or 'application/octet-stream'


# ── Panel operations ──────────────────────────────────────────────────────────

def _dashboard_dir(chat_id: str) -> Path:
    """Return the dashboards/ directory for a chat, creating it if needed."""
    d = cfg.chat_dir(chat_id) / "dashboards"
    d.mkdir(exist_ok=True)
    return d


def _dashboard_path(chat_id: str, name: str) -> Path:
    """Return the path to a panel JSON file, rejecting traversal attempts."""
    if "/" in name or "\\" in name or name.startswith("."):
        raise ValueError(f"Invalid panel name: {name}")
    return _dashboard_dir(chat_id) / f"{name}.json"


def _dashboard_commit(chat_id: str, message: str) -> Optional[str]:
    """Stage the dashboards/ directory and commit."""
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)
    subprocess.run(["git", "add", "dashboards/"], cwd=chat, capture_output=True)
    result = subprocess.run(
        ["git", "diff", "--cached", "--quiet"], cwd=chat, capture_output=True
    )
    if result.returncode == 0:
        return None  # nothing to commit
    subprocess.run(["git", "commit", "-m", message], cwd=chat, capture_output=True)
    r = subprocess.run(["git", "rev-parse", "HEAD"], cwd=chat, capture_output=True, text=True)
    return r.stdout.strip()


def dashboard_build_html(data: dict) -> str:
    """Assemble a full HTML document from panel data {html, css, js}."""
    html = data.get("html", "")
    css  = data.get("css", "")
    js   = data.get("js", "")
    return (
        "<!DOCTYPE html>\n<html>\n<head>\n"
        '  <meta charset="utf-8" />\n'
        "  <style>\n"
        "    body { margin: 0; padding: 8px; background: #18181b; color: #e4e4e7;"
        " font-family: sans-serif; font-size: 14px; }\n"
        "    * { box-sizing: border-box; }\n"
        + (f"    {css}\n" if css else "")
        + "  </style>\n</head>\n<body>\n"
        + html + "\n"
        + (f"<script>\n{js}\n</script>\n" if js else "")
        + "</body>\n</html>"
    )


def dashboard_create(chat_id: str, name: str, html: str, css: str = "", js: str = "") -> str:
    """Create a new panel. Raises ValueError if name already exists."""
    path = _dashboard_path(chat_id, name)
    if path.exists():
        raise ValueError(f"Dashboard already exists: {name}. Use dashboard_update to modify it.")
    data = {"name": name, "html": html, "css": css, "js": js}
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    _dashboard_commit(chat_id, f"[dashboard] create {name}")
    return name


def dashboard_update(chat_id: str, name: str, part: str, content: str) -> str:
    """Replace one part (html/css/js) of an existing panel."""
    if part not in ("html", "css", "js"):
        raise ValueError(f"Invalid part '{part}' — must be html, css, or js")
    path = _dashboard_path(chat_id, name)
    if not path.exists():
        raise FileNotFoundError(f"Panel not found: {name}")
    data = json.loads(path.read_text(encoding="utf-8"))
    data[part] = content
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    _dashboard_commit(chat_id, f"[dashboard] update {name}.{part}")
    return name


def dashboard_inspect(chat_id: str, name: str, part: str) -> str:
    """Return one part (html/css/js) of a panel's current content."""
    if part not in ("html", "css", "js"):
        raise ValueError(f"Invalid part '{part}' — must be html, css, or js")
    path = _dashboard_path(chat_id, name)
    if not path.exists():
        raise FileNotFoundError(f"Panel not found: {name}")
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get(part, "")


def dashboard_list(chat_id: str) -> list[dict]:
    """List all panels for a chat with name and last-modified timestamp."""
    panel_dir = _dashboard_dir(chat_id)
    results = []
    for f in sorted(panel_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).isoformat()
            results.append({"name": data.get("name", f.stem), "updatedAt": mtime})
        except Exception:
            continue
    return results


def dashboard_delete(chat_id: str, name: str):
    """Delete a panel."""
    path = _dashboard_path(chat_id, name)
    if not path.exists():
        raise FileNotFoundError(f"Panel not found: {name}")
    path.unlink()
    _dashboard_commit(chat_id, f"[dashboard] delete {name}")


def dashboard_get_html(chat_id: str, name: str) -> str:
    """Return the assembled HTML document for a panel."""
    path = _dashboard_path(chat_id, name)
    if not path.exists():
        raise FileNotFoundError(f"Panel not found: {name}")
    data = json.loads(path.read_text(encoding="utf-8"))
    return dashboard_build_html(data)
