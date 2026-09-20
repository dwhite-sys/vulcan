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
import io
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Optional

from vulcan import config as cfg


# ── Path helpers ──────────────────────────────────────────────────────────────

def _chat_path(chat_id: str, relative_path: str, *, allow_library: bool = False) -> Path:
    """Resolve a relative path within a chat's workspace/ subdir, preventing traversal."""
    base = cfg.chat_workspace_dir(chat_id).resolve()
    logical = Path(os.path.abspath(base / relative_path))
    if not logical.is_relative_to(base):
        raise ValueError(f"Path traversal denied: {relative_path}")
    full = logical.resolve()
    if full.is_relative_to(base):
        return full
    if allow_library:
        from vulcan import library
        if library.is_shared_target(full):
            return full
    if not full.is_relative_to(base):
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
            gitignore.write_text("attachments/\nshared\n", encoding="utf-8")


# ── File operations ───────────────────────────────────────────────────────────

def read_file(chat_id: str, path: str) -> str:
    """Read a text file from the chat workspace."""
    full = _chat_path(chat_id, path, allow_library=True)
    if not full.exists():
        raise FileNotFoundError(f"File not found: {path}")
    return full.read_text(encoding="utf-8", errors="replace")


def read_file_base64(chat_id: str, path: str) -> tuple[str, str]:
    """
    Read a binary file and return (base64_string, mime_type).
    Used by view_file for images.
    """
    import mimetypes
    full = _chat_path(chat_id, path, allow_library=True)
    if not full.exists():
        raise FileNotFoundError(f"File not found: {path}")
    data = full.read_bytes()
    b64  = base64.b64encode(data).decode("ascii")
    mime, _ = mimetypes.guess_type(str(full))
    mime = mime or "application/octet-stream"
    return b64, mime


def render_image_view(chat_id: str, path: str, region: dict | None = None, size: int = 512) -> dict:
    """Render a bounded whole-image overview or a fixed-size detail crop."""
    from PIL import Image, ImageOps

    full = _chat_path(chat_id, path, allow_library=True)
    if not full.exists():
        raise FileNotFoundError(f"File not found: {path}")
    with Image.open(full) as opened:
        image = ImageOps.exif_transpose(opened)
        image.seek(0)
        image.load()
    original_width, original_height = image.size
    if original_width <= 0 or original_height <= 0:
        raise ValueError(f"Image has invalid dimensions: {original_width}x{original_height}")

    if region is None:
        rendered = image.copy()
        rendered.thumbnail((size, size), Image.Resampling.LANCZOS)
        view = "overview"
        crop = None
    else:
        if not isinstance(region, dict) or "x" not in region or "y" not in region:
            raise ValueError("region requires integer x and y coordinates")
        if isinstance(region["x"], bool) or isinstance(region["y"], bool):
            raise ValueError("region x and y must be integers")
        x, y = int(region["x"]), int(region["y"])
        if x < 0 or y < 0 or x >= original_width or y >= original_height:
            raise ValueError(
                f"Crop origin ({x}, {y}) is outside the {original_width}x{original_height} image"
            )
        width = min(size, original_width - x)
        height = min(size, original_height - y)
        rendered = image.crop((x, y, x + width, y + height))
        view = "detail"
        crop = {"x": x, "y": y, "width": width, "height": height}

    if rendered.mode not in ("RGB", "RGBA"):
        rendered = rendered.convert("RGBA" if "transparency" in rendered.info else "RGB")
    output = io.BytesIO()
    rendered.save(output, format="PNG", optimize=True)
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    rendered_width, rendered_height = rendered.size
    result = {
        "dataUrl": f"data:image/png;base64,{encoded}",
        "original_width": original_width,
        "original_height": original_height,
        "rendered_width": rendered_width,
        "rendered_height": rendered_height,
        "view": view,
    }
    if crop is not None:
        result["region"] = crop
        result["guidance"] = "This is the requested detail window in original-image coordinates."
    elif original_width > size or original_height > size:
        result["guidance"] = (
            "This is a whole-image overview. To inspect detail, call view_file again with region.x and region.y "
            "set to the top-left corner of a 512x512 window in the original image."
        )
    else:
        result["guidance"] = "This overview already shows the image at its original size."
    return result


def write_file(chat_id: str, path: str, content: str):
    """Write a text file to the chat workspace, creating parent dirs as needed."""
    full = _chat_path(chat_id, path)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def write_file_bytes(chat_id: str, path: str, content: bytes):
    """Write binary content to the chat workspace, creating parent dirs as needed."""
    full = _chat_path(chat_id, path)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(content)


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
    full = _chat_path(chat_id, path, allow_library=True)
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
    visited = set()
    for current, directories, files in os.walk(base, followlinks=True):
        resolved = Path(current).resolve()
        if resolved in visited:
            directories[:] = []
            continue
        visited.add(resolved)
        for name in sorted(directories):
            results.append(str((Path(current) / name).relative_to(base)) + "/")
        for name in sorted(files):
            results.append(str((Path(current) / name).relative_to(base)))
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

def _git_path(path: str, *, allow_dashboard: bool = True) -> str:
    """Turn an application path into a safe, repository-relative Git path."""
    value = str(path or "").replace("\\", "/")
    parsed = PurePosixPath(value)
    if not value or parsed.is_absolute() or any(part in {".", ".."} for part in value.split("/")):
        raise ValueError(f"Invalid Git path: {path}")
    parts = parsed.parts
    if parts[0] == "panels" and allow_dashboard:
        parts = ("dashboards", *parts[1:])
    if parts[0] == "dashboards":
        if not allow_dashboard or len(parts) < 2:
            raise ValueError(f"Invalid Git path: {path}")
        return "/".join(parts)
    if parts[0] == "workspace":
        if len(parts) < 2:
            raise ValueError(f"Invalid Git path: {path}")
        return "/".join(parts)
    return "workspace/" + "/".join(parts)


def git_commit(chat_id: str, message: str, paths: Optional[list[str]] = None) -> Optional[str]:
    """
    Commit all current changes in workspace/ plus environment.json.
    Returns the commit hash, or None if nothing to commit.

    Commit message conventions (enforced by callers):
      [auto] <summary>  — timed dirty-check commits
      [user] <summary>  — user save from editor
    """
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)

    # Attribute an explicit edit only to its actual file. Automatic checkpoints
    # own any unrelated terminal changes rather than inheriting a false author.
    tracked_paths = [_git_path(path, allow_dashboard=False) for path in paths] if paths else ["workspace/"]
    if not paths and cfg.chat_environment_json(chat_id).exists():
        tracked_paths.append("environment.json")
    subprocess.run(["git", "add", "-A", "--", *tracked_paths], cwd=chat, capture_output=True)

    # Check if there's anything to commit
    result = subprocess.run(
        ["git", "diff", "--cached", "--quiet", "--", *tracked_paths],
        cwd=chat,
        capture_output=True,
    )
    if result.returncode == 0:
        return None  # Nothing staged

    # Commit
    result = subprocess.run(
        ["git", "commit", "-m", message, "--", *tracked_paths],
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
        args += ["--", _git_path(path)]

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
        if message.startswith("[agent]"):
            author = "agent"
        elif message.startswith("[user]") or message.startswith("User:"):
            author = "user"
        else:
            author = "auto"
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
        ["git", "show", f"{commit_hash}:{_git_path(path)}"],
        cwd=chat,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise FileNotFoundError(f"File {path} not found at commit {commit_hash}")
    return result.stdout


def git_diff(chat_id: str, path: Optional[str] = None, revision: str = "HEAD") -> str:
    """Return a bounded, read-only diff against a workspace revision."""
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)
    args = ["git", "diff", revision]
    if path:
        _chat_path(chat_id, path)
        args.extend(["--", f"workspace/{path}"])
    else:
        args.extend(["--", "workspace/"])
    result = subprocess.run(args, cwd=chat, capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or f"Could not diff revision {revision}")
    return result.stdout


def git_restore_file(chat_id: str, commit_hash: str, path: str, actor: str = "agent") -> dict:
    """Restore one workspace file after preserving all current changes."""
    if actor not in {"user", "agent", "auto"}:
        raise ValueError(f"Invalid restore actor: {actor}")
    repo_path = _git_path(path, allow_dashboard=False)
    logical_path = repo_path.removeprefix("workspace/")
    target = _chat_path(chat_id, logical_path)
    _ensure_git(chat_id)
    chat = cfg.chat_dir(chat_id)
    safety_hash = git_commit(chat_id, f"[auto] before restoring {path}")
    result = subprocess.run(
        ["git", "show", f"{commit_hash}:{repo_path}"],
        cwd=chat,
        capture_output=True,
    )
    if result.returncode != 0:
        raise FileNotFoundError(f"File {path} not found at commit {commit_hash}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(result.stdout)
    restored_hash = git_commit(chat_id, f"[{actor}] restored {logical_path} from {commit_hash[:8]}", [logical_path])
    return {"ok": True, "path": logical_path, "restored_from": commit_hash,
            "safety_commit": safety_hash, "commit": restored_hash}


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
        ["git", "checkout", commit_hash, "--", "workspace/"],
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
    repo_path = _git_path(path, allow_dashboard=False)
    full = _chat_path(chat_id, repo_path.removeprefix("workspace/"), allow_library=True)

    if not full.exists():
        return False

    result = subprocess.run(
        ["git", "diff", "HEAD", "--", repo_path],
        cwd=chat,
        capture_output=True,
        text=True,
    )
    # Also check if file is untracked (new file)
    ls_result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", repo_path],
        cwd=chat,
        capture_output=True,
    )
    is_untracked = ls_result.returncode != 0
    return bool(result.stdout.strip()) or is_untracked


def git_commit_auto(chat_id: str, summary: str) -> Optional[str]:
    """Timed dirty-check commit. No-ops if nothing changed."""
    return git_commit(chat_id, f"[auto] {summary}")


def git_commit_user(chat_id: str, summary: str, path: Optional[str] = None) -> Optional[str]:
    """User-triggered commit (e.g. Ctrl+S in editor)."""
    return git_commit(chat_id, f"[user] {summary}", [path] if path else None)


def git_commit_agent(chat_id: str, summary: str, path: str) -> Optional[str]:
    """Commit only the file changed by an explicit agent editing tool."""
    return git_commit(chat_id, f"[agent] {summary}", [path])


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
            size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file() and not f.is_symlink())
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
    base = cfg.chat_workspace_dir(chat_id).resolve()
    logical_source = Path(os.path.abspath(base / from_path))
    if logical_source.is_relative_to(base) and logical_source.is_symlink():
        target = logical_source.resolve()
        from vulcan import library
        if library.is_shared_target(target):
            record = library.describe(target)
            library.attach(chat_id, record["file_id"], to_path)
            logical_source.unlink()
            return
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
    base = cfg.chat_workspace_dir(chat_id).resolve()
    logical = Path(os.path.abspath(base / path))
    if logical.is_relative_to(base) and logical.is_symlink():
        target = logical.resolve()
        from vulcan import library
        if library.is_shared_target(target):
            logical.unlink()
            return
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
    full = _chat_path(chat_id, path, allow_library=True)
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
    full = _chat_path(chat_id, clean, allow_library=True)
    if not full.exists():
        raise FileNotFoundError(f"Not found: {path}")

    if full.is_dir():
        return zip_folder(chat_id, clean), f"{Path(clean).name}.zip", 'application/zip'

    exposed_name = Path(clean).name
    mime, _ = mimetypes.guess_type(exposed_name)
    return full.read_bytes(), exposed_name, mime or 'application/octet-stream'


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
    subprocess.run(["git", "add", "-A", "--", "dashboards/"], cwd=chat, capture_output=True)
    result = subprocess.run(
        ["git", "diff", "--cached", "--quiet", "--", "dashboards/"], cwd=chat, capture_output=True
    )
    if result.returncode == 0:
        return None  # nothing to commit
    subprocess.run(["git", "commit", "-m", message, "--", "dashboards/"], cwd=chat, capture_output=True)
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


def dashboard_create(chat_id: str, name: str, html: str, css: str = "", js: str = "", *, actor: str = "auto") -> str:
    """Create a new panel. Raises ValueError if name already exists."""
    path = _dashboard_path(chat_id, name)
    if path.exists():
        raise ValueError(f"Dashboard already exists: {name}. Use dashboard_update to modify it.")
    data = {"name": name, "html": html, "css": css, "js": js}
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    _dashboard_commit(chat_id, f"[{actor if actor in {'user', 'agent'} else 'auto'}] create dashboard {name}")
    return name


def dashboard_update(chat_id: str, name: str, part: str, content: str, *, actor: str = "auto") -> str:
    """Replace one part (html/css/js) of an existing panel."""
    if part not in ("html", "css", "js"):
        raise ValueError(f"Invalid part '{part}' — must be html, css, or js")
    path = _dashboard_path(chat_id, name)
    if not path.exists():
        raise FileNotFoundError(f"Panel not found: {name}")
    data = json.loads(path.read_text(encoding="utf-8"))
    data[part] = content
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    _dashboard_commit(chat_id, f"[{actor if actor in {'user', 'agent'} else 'auto'}] update dashboard {name}.{part}")
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


def dashboard_delete(chat_id: str, name: str, *, actor: str = "auto"):
    """Delete a panel."""
    path = _dashboard_path(chat_id, name)
    if not path.exists():
        raise FileNotFoundError(f"Panel not found: {name}")
    path.unlink()
    _dashboard_commit(chat_id, f"[{actor if actor in {'user', 'agent'} else 'auto'}] delete dashboard {name}")


def dashboard_get_html(chat_id: str, name: str) -> str:
    """Return the assembled HTML document for a panel."""
    path = _dashboard_path(chat_id, name)
    if not path.exists():
        raise FileNotFoundError(f"Panel not found: {name}")
    data = json.loads(path.read_text(encoding="utf-8"))
    return dashboard_build_html(data)
