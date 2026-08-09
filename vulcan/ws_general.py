"""
vulcan/ws_general.py — General WebSocket handler

Replaces the REST API for all non-streaming, non-SSH operations.
One WebSocket connection per Electron session.

Message protocol
────────────────
Every message is JSON with:
  { "id": "<uuid>", "type": "<namespace>/<action>", "payload": {...} }

Responses mirror the request id:
  { "id": "<uuid>", "type": "<namespace>/<action>/response", "payload": {...} }
  { "id": "<uuid>", "type": "error", "payload": { "message": "..." } }

Server-push messages (no id):
  { "type": "push/<event>", "payload": {...} }

Authentication
──────────────
If the server has a password set, the first message must be:
  { "id": "...", "type": "auth/login", "payload": { "password": "..." } }

If no password is set, all messages are accepted immediately.

Namespaces
──────────
  ping
  auth/login
  chats/list, chats/get, chats/upsert, chats/delete
  terminal/slots, terminal/slot/open, terminal/slot/close,
    terminal/slot/run, terminal/slot/output, terminal/result,
    terminal/detach, terminal/kill, terminal/wait
  workspace/read-file, workspace/write-file, workspace/create-directory, workspace/edit-file,
    workspace/read-file-base64, workspace/list-files, workspace/path,
    workspace/present, workspace/rename-file, workspace/delete-file,
    workspace/download-folder, workspace/export
  git/log, git/show, git/commit, git/restore
  snapshot/save, snapshot/list, snapshot/show
  workspace/list-all, workspace/delete
  attachment/upload  (multipart still uses REST — binary data)
  container/status, container/start, container/stop,
    container/reset, container/nuke, containers/running
  dashboard/create, dashboard/update, dashboard/inspect,
    dashboard/list, dashboard/get, dashboard/delete
  blobs/store, blobs/get, blobs/list, blobs/delete  (SSH target store)
"""

import asyncio
import json
import logging
import re
import uuid as uuid_mod
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from vulcan import auth
from vulcan import chats as chat_store
from vulcan import chat_folders as folder_store
from vulcan import config as cfg
from vulcan import docker
from vulcan import terminal as term
from vulcan import workspace
from vulcan.secure_ws import SecureWebSocketSession

logger = logging.getLogger("vulcan.ws_general")


# ── Blob store (opaque encrypted blobs for SSH targets) ───────────────────────
# Simple in-memory + disk store. Blobs are opaque to the server.

import os
from pathlib import Path

def _blobs_file() -> Path:
    return cfg.CONFIG_DIR / "blobs.json"

def _load_blobs() -> dict:
    try:
        p = _blobs_file()
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}

def _save_blobs(blobs: dict):
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _blobs_file().with_suffix(".tmp")
    tmp.write_text(json.dumps(blobs), encoding="utf-8")
    os.replace(tmp, _blobs_file())


# ── Message handler ───────────────────────────────────────────────────────────

class GeneralWSSession:
    def __init__(self, secure_ws: SecureWebSocketSession):
        self.ws           = secure_ws
        self.authenticated = not auth.server_requires_auth()  # open if no password
        self.session_token: str | None = None
        self._uploads: dict[str, dict[str, Any]] = {}
        self._workspace_exports: dict[str, dict[str, Any]] = {}

    def cleanup(self):
        for state in list(self._uploads.values()):
            self._cleanup_upload_state(state)
        self._uploads.clear()
        self._workspace_exports.clear()

    async def send(self, msg: dict):
        try:
            await self.ws.send_json(msg)
        except Exception:
            pass

    async def respond(self, req_id: str, msg_type: str, payload: Any):
        await self.send({"id": req_id, "type": f"{msg_type}/response", "payload": payload})

    async def error(self, req_id: str, message: str):
        await self.send({"id": req_id, "type": "error", "payload": {"message": message}})

    async def handle_message(self, msg: dict):
        req_id   = msg.get("id", str(uuid_mod.uuid4()))
        msg_type = msg.get("type", "")
        payload  = msg.get("payload", {})

        # Auth gate
        if not self.authenticated:
            if msg_type == "auth/login":
                await self._handle_auth_login(req_id, payload)
            else:
                await self.error(req_id, "Authentication required. Send auth/login first.")
            return

        # Dispatch
        handler = self._routes().get(msg_type)
        if handler:
            try:
                await handler(req_id, payload)
            except Exception as e:
                logger.warning(f"WS handler error [{msg_type}]: {e}")
                await self.error(req_id, str(e))
        else:
            await self.error(req_id, f"Unknown message type: {msg_type}")

    async def _handle_auth_login(self, req_id: str, payload: dict):
        password = payload.get("password", "")
        if auth.verify_server_password(password):
            self.authenticated = True
            token = auth.create_session("ws-general")
            self.session_token = token
            await self.respond(req_id, "auth/login", {"ok": True})
        else:
            await self.error(req_id, "Invalid server password")

    def _routes(self) -> dict:
        return {
            # Ping
            "ping":                        self._ping,
            # Chats
            "chats/list":                  self._chats_list,
            "chats/get":                   self._chats_get,
            "chats/upsert":                self._chats_upsert,
            "chats/delete":                self._chats_delete,
            "chat-folders/list":          self._chat_folders_list,
            "chat-folders/save":          self._chat_folders_save,
            # Terminal
            "terminal/slots":              self._terminal_slots,
            "terminal/active-chats":       self._terminal_active_chats,
            "terminal/slot/open":          self._terminal_slot_open,
            "terminal/slot/close":         self._terminal_slot_close,
            "terminal/slot/run":           self._terminal_slot_run,
            "terminal/slot/output":        self._terminal_slot_output,
            "terminal/result":             self._terminal_result,
            "terminal/detach":             self._terminal_detach,
            "terminal/kill":               self._terminal_kill,
            "terminal/wait":               self._terminal_wait,
            # Workspace files
            "workspace/read-file":         self._workspace_read_file,
            "workspace/write-file":        self._workspace_write_file,
            "workspace/create-directory":  self._workspace_create_directory,
            "workspace/edit-file":         self._workspace_edit_file,
            "workspace/find-in-file":      self._workspace_find_in_file,
            "workspace/read-file-base64":  self._workspace_read_file_base64,
            "workspace/list-files":        self._workspace_list_files,
            "workspace/path":              self._workspace_path,
            "workspace/present":           self._workspace_present,
            "workspace/rename-file":       self._workspace_rename_file,
            "workspace/delete-file":       self._workspace_delete_file,
            "workspace/download-folder":   self._workspace_download_folder,
            "workspace/export":            self._workspace_export,
            "workspace/export/prepare":    self._workspace_export_prepare,
            "workspace/export/chunk":      self._workspace_export_chunk,
            "workspace/export/finish":     self._workspace_export_finish,
            "workspace/export/cancel":     self._workspace_export_cancel,
            "attachment/upload/start":      self._attachment_upload_start,
            "attachment/upload/chunk":      self._attachment_upload_chunk,
            "attachment/upload/finish":     self._attachment_upload_finish,
            "attachment/upload/cancel":     self._attachment_upload_cancel,
            # Git
            "git/log":                     self._git_log,
            "git/show":                    self._git_show,
            "git/commit":                  self._git_commit,
            "git/restore":                 self._git_restore,
            # Snapshots
            "snapshot/save":               self._snapshot_save,
            "snapshot/list":               self._snapshot_list,
            "snapshot/show":               self._snapshot_show,
            # Workspace management
            "workspace/list-all":          self._workspace_list_all,
            "workspace/delete":            self._workspace_delete,
            # Container
            "container/status":            self._container_status,
            "container/start":             self._container_start,
            "container/stop":              self._container_stop,
            "container/reset":             self._container_reset,
            "container/nuke":              self._container_nuke,
            "containers/running":          self._containers_running,
            # Persistent global environment
            "global/status":               self._global_status,
            "global/start":                self._global_start,
            "global/stop":                 self._global_stop,
            "global/restart":              self._global_restart,
            # Dashboards
            "dashboard/create":            self._dashboard_create,
            "dashboard/update":            self._dashboard_update,
            "dashboard/inspect":           self._dashboard_inspect,
            "dashboard/list":              self._dashboard_list,
            "dashboard/get":               self._dashboard_get,
            "dashboard/delete":            self._dashboard_delete,
            # Blob store (SSH targets — opaque encrypted blobs)
            "blobs/store":                 self._blobs_store,
            "blobs/get":                   self._blobs_get,
            "blobs/list":                  self._blobs_list,
            "blobs/delete":                self._blobs_delete,
        }

    # ── Ping ──────────────────────────────────────────────────────────────────

    async def _ping(self, req_id: str, p: dict):
        await self.respond(req_id, "ping", {"ok": True})

    # ── Chats ─────────────────────────────────────────────────────────────────

    async def _chats_list(self, req_id: str, p: dict):
        await self.respond(req_id, "chats/list", {"chats": chat_store.load_all_chats()})

    async def _chats_get(self, req_id: str, p: dict):
        chat = chat_store.load_chat(p["chat_id"])
        if chat is None:
            await self.error(req_id, "Chat not found")
        else:
            await self.respond(req_id, "chats/get", {"chat": chat})

    async def _chats_upsert(self, req_id: str, p: dict):
        chat = p.get("chat")
        if not chat or not chat.get("id"):
            await self.error(req_id, "Missing chat or chat.id")
            return
        chat_store.save_chat(chat)
        await self.respond(req_id, "chats/upsert", {"ok": True})

    async def _chats_delete(self, req_id: str, p: dict):
        deleted = chat_store.delete_chat(p["chat_id"])
        if not deleted:
            await self.error(req_id, "Chat not found")
        else:
            await self.respond(req_id, "chats/delete", {"ok": True})

    async def _chat_folders_list(self, req_id: str, p: dict):
        await self.respond(req_id, "chat-folders/list", {"folders": folder_store.load_folders()})

    async def _chat_folders_save(self, req_id: str, p: dict):
        folders = p.get("folders")
        if not isinstance(folders, list):
            await self.error(req_id, "Missing folders list")
            return
        folder_store.save_folders(folders)
        await self.respond(req_id, "chat-folders/save", {"ok": True})

    # ── Terminal ──────────────────────────────────────────────────────────────

    async def _terminal_slots(self, req_id: str, p: dict):
        await self.respond(req_id, "terminal/slots", {"slots": term.list_slots(p["chat_id"])})

    async def _terminal_active_chats(self, req_id: str, p: dict):
        await self.respond(req_id, "terminal/active-chats", {
            "chat_ids": term.active_chat_ids(),
            "statuses": term.terminal_chat_statuses(),
        })

    async def _terminal_slot_open(self, req_id: str, p: dict):
        try:
            slot = term.open_slot(p["chat_id"], p.get("kind", "user"))
            await self.respond(req_id, "terminal/slot/open", {"slot": slot})
        except ValueError as e:
            await self.error(req_id, str(e))

    async def _terminal_slot_close(self, req_id: str, p: dict):
        term.close_slot(p["chat_id"], p["kind"], int(p["slot"]))
        await self.respond(req_id, "terminal/slot/close", {"ok": True})

    async def _terminal_slot_run(self, req_id: str, p: dict):
        try:
            pid = term.run_command_in_slot(
                p["chat_id"], p.get("kind", "agent"), int(p["slot"]),
                p["cmd"], int(p.get("timeout", 180))
            )
            await self.respond(req_id, "terminal/slot/run", {"pid": pid})
        except RuntimeError as e:
            await self.error(req_id, str(e))

    async def _terminal_slot_output(self, req_id: str, p: dict):
        output = term.read_slot_output(p["chat_id"], p["kind"], int(p["slot"]), int(p.get("lines", 50)))
        await self.respond(req_id, "terminal/slot/output", {"output": output})

    async def _terminal_result(self, req_id: str, p: dict):
        pid = p["pid"]
        cp = term.get_command(pid)
        wp = term.get_wait(pid) if not cp else None
        if cp:
            await self.respond(req_id, "terminal/result", {
                "pid": pid, "output": "".join(cp.output).strip(),
                "finished": cp.finished, "exit_code": cp.exit_code,
                "detached": cp.detached, "detach_reason": cp.detach_reason,
            })
        elif wp:
            await self.respond(req_id, "terminal/result", {
                "pid": pid, "output": f"Waited {wp.seconds}s.",
                "finished": wp.finished, "exit_code": 0,
                "detached": wp.detached, "detach_reason": wp.detach_reason,
            })
        else:
            await self.error(req_id, f"Unknown pid: {pid}")

    async def _terminal_detach(self, req_id: str, p: dict):
        pid = p["pid"]
        ok1 = term.detach_process(pid, p.get("reason", ""))
        ok2 = term.detach_wait(pid) if not ok1 else False
        await self.respond(req_id, "terminal/detach", {"ok": ok1 or ok2})

    async def _terminal_kill(self, req_id: str, p: dict):
        await self.respond(req_id, "terminal/kill", {"ok": term.kill_process(p["pid"])})

    async def _terminal_wait(self, req_id: str, p: dict):
        pid = term.start_wait(p["chat_id"], float(p.get("seconds", 5)))
        await self.respond(req_id, "terminal/wait", {"pid": pid})

    # ── Workspace files ───────────────────────────────────────────────────────

    async def _workspace_read_file(self, req_id: str, p: dict):
        try:
            content = workspace.read_file(p["chat_id"], p["path"])
            await self.respond(req_id, "workspace/read-file", {"content": content})
        except FileNotFoundError as e:
            await self.error(req_id, str(e))

    async def _workspace_write_file(self, req_id: str, p: dict):
        workspace.write_file(p["chat_id"], p["path"], p.get("content", ""))
        await self.respond(req_id, "workspace/write-file", {"ok": True})

    async def _workspace_create_directory(self, req_id: str, p: dict):
        workspace.create_directory(p["chat_id"], p["path"])
        await self.respond(req_id, "workspace/create-directory", {"ok": True})

    async def _workspace_edit_file(self, req_id: str, p: dict):
        result = workspace.edit_file(p["chat_id"], p["path"], p.get("edits", []))
        await self.respond(req_id, "workspace/edit-file", result)

    async def _workspace_find_in_file(self, req_id: str, p: dict):
        matches = workspace.find_in_file(p["chat_id"], p["path"], p.get("query", ""))
        await self.respond(req_id, "workspace/find-in-file", {"matches": matches})

    async def _workspace_read_file_base64(self, req_id: str, p: dict):
        result = workspace.read_file_base64(p["chat_id"], p["path"])
        b64, mime = result
        await self.respond(req_id, "workspace/read-file-base64", {"base64": b64, "mimeType": mime})

    async def _workspace_list_files(self, req_id: str, p: dict):
        files = workspace.list_files(p["chat_id"])
        await self.respond(req_id, "workspace/list-files", {"files": files})

    async def _workspace_path(self, req_id: str, p: dict):
        path = str(cfg.chat_workspace_dir(p["chat_id"]))
        await self.respond(req_id, "workspace/path", {"path": path})

    async def _workspace_present(self, req_id: str, p: dict):
        workspace.present_file(p["chat_id"], p["path"])
        await self.respond(req_id, "workspace/present", {"ok": True})

    async def _workspace_rename_file(self, req_id: str, p: dict):
        workspace.rename_path(p["chat_id"], p["old_path"], p["new_path"])
        await self.respond(req_id, "workspace/rename-file", {"ok": True})

    async def _workspace_delete_file(self, req_id: str, p: dict):
        workspace.delete_path(p["chat_id"], p["path"])
        await self.respond(req_id, "workspace/delete-file", {"ok": True})

    async def _workspace_download_folder(self, req_id: str, p: dict):
        import base64
        raw = workspace.zip_folder(p["chat_id"], p.get("path", "/workspace"))
        await self.respond(req_id, "workspace/download-folder", {"base64": base64.b64encode(raw).decode()})

    async def _workspace_export(self, req_id: str, p: dict):
        import base64
        raw, filename, mime_type = workspace.export_workspace_item(p["chat_id"], p["path"])
        await self.respond(req_id, "workspace/export", {
            "base64": base64.b64encode(raw).decode("ascii"),
            "filename": filename,
            "mimeType": mime_type,
        })

    async def _workspace_export_prepare(self, req_id: str, p: dict):
        raw, filename, mime_type = workspace.export_workspace_item(p["chat_id"], p["path"])
        export_id = str(uuid_mod.uuid4())
        self._workspace_exports[export_id] = {
            "raw": raw,
            "filename": filename,
            "mimeType": mime_type,
        }
        await self.respond(req_id, "workspace/export/prepare", {
            "export_id": export_id,
            "filename": filename,
            "mimeType": mime_type,
            "size": len(raw),
        })

    async def _workspace_export_chunk(self, req_id: str, p: dict):
        import base64
        export_id = str(p.get("export_id", ""))
        state = self._workspace_exports.get(export_id)
        if state is None:
            raise ValueError("Workspace export not found or expired")
        offset = max(0, int(p.get("offset", 0)))
        chunk_size = min(max(1, int(p.get("chunk_size", 384 * 1024))), 1024 * 1024)
        raw = state["raw"]
        chunk = raw[offset:offset + chunk_size]
        next_offset = offset + len(chunk)
        await self.respond(req_id, "workspace/export/chunk", {
            "data": base64.b64encode(chunk).decode("ascii"),
            "offset": offset,
            "next_offset": next_offset,
            "done": next_offset >= len(raw),
        })

    async def _workspace_export_finish(self, req_id: str, p: dict):
        export_id = str(p.get("export_id", ""))
        self._workspace_exports.pop(export_id, None)
        await self.respond(req_id, "workspace/export/finish", {"ok": True})

    async def _workspace_export_cancel(self, req_id: str, p: dict):
        export_id = str(p.get("export_id", ""))
        self._workspace_exports.pop(export_id, None)
        await self.respond(req_id, "workspace/export/cancel", {"ok": True})

    # ── Encrypted streamed upload ────────────────────────────────────────────

    @staticmethod
    def _configured_max_upload_bytes() -> int | None:
        value = cfg.load().get("vulcan", {}).get("max_upload_size")
        if value in (None, "", 0, "0"):
            return None
        if isinstance(value, (int, float)):
            return max(0, int(value)) or None
        text = str(value).strip()
        match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)?", text, re.I)
        if not match:
            raise ValueError(f"Invalid vulcan.max_upload_size: {value!r}")
        amount = float(match.group(1))
        unit = (match.group(2) or "b").lower()
        powers = {"b": 0, "kb": 1, "kib": 1, "mb": 2, "mib": 2, "gb": 3, "gib": 3, "tb": 4, "tib": 4, "pb": 5, "pib": 5, "eb": 6, "eib": 6}
        base = 1024 if "i" in unit else 1000
        return int(amount * (base ** powers[unit]))

    @staticmethod
    def _cleanup_upload_state(state: dict, *, remove_tmp: bool = True):
        fh = state.get("fh")
        if fh is not None:
            try:
                fh.close()
            except Exception:
                pass
            state["fh"] = None
        if remove_tmp:
            tmp_path = state.get("tmp_path")
            if tmp_path:
                try:
                    Path(tmp_path).unlink(missing_ok=True)
                except Exception:
                    pass

    async def _attachment_upload_start(self, req_id: str, p: dict):
        filename = str(p.get("filename", "attachment"))
        chat_id = str(p.get("chat_id", ""))
        expected = int(p.get("size", 0))
        if not chat_id:
            await self.error(req_id, "Missing chat_id")
            return
        if expected < 0:
            await self.error(req_id, "Attachment size cannot be negative")
            return
        try:
            limit = self._configured_max_upload_bytes()
        except ValueError as exc:
            await self.error(req_id, str(exc))
            return
        if limit is not None and expected > limit:
            await self.error(req_id, f"Upload exceeds server limit ({limit} bytes)")
            return

        try:
            final_path, public_path, is_workspace = workspace.prepare_upload_destination(
                chat_id, filename, str(p.get("workspace_path", "")).strip() or None
            )
        except Exception as exc:
            await self.error(req_id, str(exc))
            return

        upload_id = str(uuid_mod.uuid4())
        tmp_path = final_path.with_name(final_path.name + ".tmp")
        try:
            tmp_path.parent.mkdir(parents=True, exist_ok=True)
            if tmp_path.exists():
                raise FileExistsError(f"Temporary upload path already exists: {tmp_path.name}")
            fh = open(tmp_path, "xb")
        except Exception as exc:
            await self.error(req_id, f"Unable to create upload temp file: {exc}")
            return

        self._uploads[upload_id] = {
            "chat_id": chat_id,
            "filename": final_path.name,
            "expected": expected,
            "received": 0,
            "limit": limit,
            "final_path": final_path,
            "tmp_path": tmp_path,
            "public_path": public_path,
            "workspace": is_workspace,
            "fh": fh,
        }
        await self.respond(req_id, "attachment/upload/start", {"upload_id": upload_id, "received": 0})

    async def _attachment_upload_chunk(self, req_id: str, p: dict):
        import base64
        upload_id = str(p.get("upload_id", ""))
        state = self._uploads.get(upload_id)
        if state is None:
            await self.error(req_id, "Unknown attachment upload")
            return
        try:
            chunk = base64.b64decode(str(p.get("data", "")), validate=True)
        except Exception:
            await self.error(req_id, "Invalid attachment chunk")
            return

        next_received = int(state["received"]) + len(chunk)
        limit = state.get("limit")
        if next_received > int(state["expected"]) or (limit is not None and next_received > int(limit)):
            self._uploads.pop(upload_id, None)
            self._cleanup_upload_state(state)
            await self.error(req_id, "Attachment upload exceeded declared or configured size")
            return
        try:
            state["fh"].write(chunk)
            state["received"] = next_received
        except Exception as exc:
            self._uploads.pop(upload_id, None)
            self._cleanup_upload_state(state)
            await self.error(req_id, f"Failed writing upload: {exc}")
            return
        # ACK only after this chunk has been accepted by the server-side file.
        await self.respond(req_id, "attachment/upload/chunk", {"received": next_received})

    async def _attachment_upload_finish(self, req_id: str, p: dict):
        upload_id = str(p.get("upload_id", ""))
        state = self._uploads.pop(upload_id, None)
        if state is None:
            await self.error(req_id, "Unknown attachment upload")
            return
        if int(state["received"]) != int(state["expected"]):
            self._cleanup_upload_state(state)
            await self.error(req_id, f"Attachment size mismatch: received {state['received']}, expected {state['expected']}")
            return
        try:
            fh = state.get("fh")
            if fh is not None:
                fh.flush()
                os.fsync(fh.fileno())
                fh.close()
                state["fh"] = None
            os.replace(state["tmp_path"], state["final_path"])
        except Exception as exc:
            self._cleanup_upload_state(state)
            await self.error(req_id, f"Failed finalizing upload: {exc}")
            return
        await self.respond(req_id, "attachment/upload/finish", {
            "filename": state["filename"],
            "path": state["public_path"],
            "workspace": bool(state["workspace"]),
            "received": state["received"],
        })

    async def _attachment_upload_cancel(self, req_id: str, p: dict):
        state = self._uploads.pop(str(p.get("upload_id", "")), None)
        if state is not None:
            self._cleanup_upload_state(state)
        await self.respond(req_id, "attachment/upload/cancel", {"ok": True})

    # ── Git ───────────────────────────────────────────────────────────────────

    async def _git_log(self, req_id: str, p: dict):
        log = workspace.git_log(p["chat_id"], p.get("path"))
        await self.respond(req_id, "git/log", {"log": log})

    async def _git_show(self, req_id: str, p: dict):
        result = workspace.git_show(p["chat_id"], p["hash"], p.get("path", ""))
        await self.respond(req_id, "git/show", {"content": result})

    async def _git_commit(self, req_id: str, p: dict):
        workspace.git_commit(p["chat_id"], p["message"])
        await self.respond(req_id, "git/commit", {"ok": True})

    async def _git_restore(self, req_id: str, p: dict):
        result = workspace.git_restore(p["chat_id"], p["hash"])
        await self.respond(req_id, "git/restore", {"output": result})

    # ── Snapshots ─────────────────────────────────────────────────────────────

    async def _snapshot_save(self, req_id: str, p: dict):
        snap_id = workspace.save_snapshot(p["chat_id"], p["path"])
        await self.respond(req_id, "snapshot/save", {"id": snap_id})

    async def _snapshot_list(self, req_id: str, p: dict):
        snaps = workspace.list_snapshots(p["chat_id"], p["path"])
        await self.respond(req_id, "snapshot/list", {"snapshots": snaps})

    async def _snapshot_show(self, req_id: str, p: dict):
        content = workspace.get_snapshot_content(p["chat_id"], p["id"], p["path"])
        await self.respond(req_id, "snapshot/show", {"content": content})

    # ── Workspace management ──────────────────────────────────────────────────

    async def _workspace_list_all(self, req_id: str, p: dict):
        workspaces = workspace.list_workspaces()
        await self.respond(req_id, "workspace/list-all", {"workspaces": workspaces})

    async def _workspace_delete(self, req_id: str, p: dict):
        workspace.delete_workspace(p["chat_id"])
        await self.respond(req_id, "workspace/delete", {"ok": True})

    # ── Container ─────────────────────────────────────────────────────────────

    async def _container_status(self, req_id: str, p: dict):
        await self.respond(req_id, "container/status", docker.status(p["chat_id"]))

    async def _container_start(self, req_id: str, p: dict):
        ok = await asyncio.to_thread(docker.start_container, p["chat_id"], False, bool(p.get("global_chat", False)))
        await self.respond(req_id, "container/start", {"ok": ok})

    async def _container_stop(self, req_id: str, p: dict):
        docker.stop_container(p.get("chat_id"))
        await self.respond(req_id, "container/stop", {"ok": True})

    async def _container_reset(self, req_id: str, p: dict):
        docker.reset_container(p["chat_id"])
        await self.respond(req_id, "container/reset", {"ok": True})

    async def _container_nuke(self, req_id: str, p: dict):
        docker.nuke_chat(p["chat_id"])
        await self.respond(req_id, "container/nuke", {"ok": True})

    async def _containers_running(self, req_id: str, p: dict):
        await self.respond(req_id, "containers/running", {"chat_ids": docker.list_running_containers()})

    # ── Global environment ──────────────────────────────────────────────────

    async def _global_status(self, req_id: str, p: dict):
        await self.respond(req_id, "global/status", docker.global_status())

    async def _global_start(self, req_id: str, p: dict):
        ok = await asyncio.to_thread(docker.ensure_global)
        await self.respond(req_id, "global/start", {"ok": ok, **docker.global_status()})

    async def _global_stop(self, req_id: str, p: dict):
        ok = await asyncio.to_thread(docker.stop_global)
        await self.respond(req_id, "global/stop", {"ok": ok, **docker.global_status()})

    async def _global_restart(self, req_id: str, p: dict):
        # A global terminal is a docker-exec PTY inside the container. Close it
        # before restart so clients receive a clean terminal lifecycle instead
        # of remaining attached to a dead exec process.
        term.close_chat_slots(docker.GLOBAL_CHAT_ID, reason="restart")
        ok = await asyncio.to_thread(docker.restart_global)
        await self.respond(req_id, "global/restart", {"ok": ok, **docker.global_status()})

    # ── Dashboards ────────────────────────────────────────────────────────────

    async def _dashboard_create(self, req_id: str, p: dict):
        workspace.dashboard_create(p["chat_id"], p["name"], p.get("html", ""), p.get("css", ""), p.get("js", ""))
        await self.respond(req_id, "dashboard/create", {"ok": True})

    async def _dashboard_update(self, req_id: str, p: dict):
        workspace.dashboard_update(p["chat_id"], p["name"], p["part"], p.get("content", ""))
        await self.respond(req_id, "dashboard/update", {"ok": True})

    async def _dashboard_inspect(self, req_id: str, p: dict):
        content = workspace.dashboard_inspect(p["chat_id"], p["name"], p["part"])
        await self.respond(req_id, "dashboard/inspect", {"content": content})

    async def _dashboard_list(self, req_id: str, p: dict):
        dashboards = workspace.dashboard_list(p["chat_id"])
        await self.respond(req_id, "dashboard/list", {"dashboards": dashboards})

    async def _dashboard_get(self, req_id: str, p: dict):
        html = workspace.dashboard_get_html(p["chat_id"], p["name"])
        await self.respond(req_id, "dashboard/get", {"html": html})

    async def _dashboard_delete(self, req_id: str, p: dict):
        workspace.dashboard_delete(p["chat_id"], p["name"])
        await self.respond(req_id, "dashboard/delete", {"ok": True})

    # ── Blob store ────────────────────────────────────────────────────────────

    async def _blobs_store(self, req_id: str, p: dict):
        blob_id   = p.get("id")
        blob_data = p.get("data")
        if not blob_id or blob_data is None:
            await self.error(req_id, "Missing id or data")
            return
        blobs = _load_blobs()
        blobs[blob_id] = blob_data
        _save_blobs(blobs)
        await self.respond(req_id, "blobs/store", {"ok": True, "id": blob_id})

    async def _blobs_get(self, req_id: str, p: dict):
        blob_id = p.get("id")
        if not blob_id:
            await self.error(req_id, "Missing id")
            return
        blobs = _load_blobs()
        if blob_id not in blobs:
            await self.error(req_id, f"Blob not found: {blob_id}")
            return
        await self.respond(req_id, "blobs/get", {"id": blob_id, "data": blobs[blob_id]})

    async def _blobs_list(self, req_id: str, p: dict):
        blobs = _load_blobs()
        await self.respond(req_id, "blobs/list", {"ids": list(blobs.keys())})

    async def _blobs_delete(self, req_id: str, p: dict):
        blob_id = p.get("id")
        if not blob_id:
            await self.error(req_id, "Missing id")
            return
        blobs = _load_blobs()
        if blob_id in blobs:
            del blobs[blob_id]
            _save_blobs(blobs)
        await self.respond(req_id, "blobs/delete", {"ok": True})


# ── Main WebSocket handler ────────────────────────────────────────────────────

async def handle(ws: WebSocket):
    secure_ws = await SecureWebSocketSession.accept(ws)
    session = GeneralWSSession(secure_ws)

    # Authentication begins only after the encrypted session is established.
    requires_auth = auth.server_requires_auth()
    await session.send({
        "type": "push/connected",
        "payload": {"requires_auth": requires_auth, "version": "0.1.0", "encrypted": True},
    })

    try:
        while True:
            message = await secure_ws.receive_json()
            if not isinstance(message, dict):
                raise ValueError("Secure application message must be an object")
            await session.handle_message(message)
    except WebSocketDisconnect:
        if session.session_token:
            auth.revoke_session(session.session_token)
    except Exception as e:
        logger.error(f"General WS fatal: {e}")
        if session.session_token:
            auth.revoke_session(session.session_token)
        try:
            await ws.close()
        except Exception:
            pass
    finally:
        session.cleanup()
