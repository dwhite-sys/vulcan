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
import time
import uuid as uuid_mod
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from vulcan import auth
from vulcan import chats as chat_store
from vulcan import chat_folders as folder_store
from vulcan import config as cfg
from vulcan import docker
from vulcan import library
from vulcan import terminal as term
from vulcan import workspace
from vulcan import agent_runtime
from vulcan import container_lifecycle
from vulcan import etna_registry
from vulcan.secure_ws import SecureWebSocketSession

logger = logging.getLogger("vulcan.ws_general")


# ── Blob store (opaque encrypted blobs for SSH targets) ───────────────────────
# Simple in-memory + disk store. Blobs are opaque to the server.

import os
import threading
from pathlib import Path

_BLOBS_LOCK = threading.RLock()

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
        self.client_presence_id = uuid_mod.uuid4().hex
        self.client_device_id: str | None = None
        self._uploads: dict[str, dict[str, Any]] = {}
        self._workspace_exports: dict[str, dict[str, Any]] = {}
        self._latest_messages: dict[str, dict[str, Any]] = {}
        self._latest_tasks: dict[str, asyncio.Task] = {}
        self._send_queue: asyncio.PriorityQueue[tuple[int, int, dict, asyncio.Future]] = asyncio.PriorityQueue()
        self._send_sequence = 0
        self._send_task = asyncio.create_task(self._drain_send_queue(), name="general-ws-send")

    @staticmethod
    def _message_priority(msg: dict) -> int:
        """Lower numbers are latency-sensitive; bulk snapshots go last.

        SecureWebSocket still owns encryption sequence/order.  This queue only
        decides which *not-yet-sent* application frame gets that next sequence
        number, so tiny RPC responses cannot sit behind a backlog of replaceable
        renderer updates.
        """
        msg_type = str(msg.get("type") or "")
        # Response frames inherit the cost/latency class of their originating
        # RPC instead of all jumping to the front merely because they have an id.
        if msg.get("id"):
            if msg_type.startswith("runs/start/") or msg_type.startswith("runs/cancel/") or msg_type.startswith("client/proof-of-life/"):
                return 0
            if msg_type.startswith("workspace/path/") or msg_type.startswith("terminal/slots/") or msg_type.startswith("runs/status/"):
                return 1
            if msg_type.startswith("chats/upsert/") or msg_type.startswith("semantic/embed/"):
                return 7
            if msg_type.startswith("workspace/list-files/") or msg_type.startswith("chats/list/") or msg_type.startswith("transcript/search/"):
                return 8
            return 3
        if msg_type in {"push/client-http-request", "push/client-http-cancel"}:
            return 0
        if msg_type in {
            "push/connected", "push/run-status", "push/generation-complete", "push/run-question", "push/design-action",
        }:
            return 1
        if msg_type == "push/run-events":
            return 9
        if msg_type == "push/run-event":
            return 6
        return 3

    async def _drain_send_queue(self) -> None:
        while True:
            _priority, _order, msg, future = await self._send_queue.get()
            if future.cancelled():
                continue
            try:
                await self.ws.send_json(msg)
            except asyncio.CancelledError:
                if not future.done():
                    future.cancel()
                raise
            except Exception as exc:
                if not future.done():
                    future.set_exception(exc)
            else:
                if not future.done():
                    future.set_result(None)

    def cleanup(self):
        # A disconnected client loses its subscription/presence, never the
        # server-owned run. Presence is session-scoped so another client viewing
        # the same chat keeps its own idle-shutdown lease.
        agent_runtime.MANAGER.unsubscribe(self)
        container_lifecycle.set_client_chat(self.client_presence_id, None)
        etna_registry.unregister_client(self.client_device_id, self)
        for state in list(self._uploads.values()):
            self._cleanup_upload_state(state)
        self._uploads.clear()
        self._workspace_exports.clear()
        self._latest_messages.clear()
        for task in self._latest_tasks.values():
            task.cancel()
        self._latest_tasks.clear()
        self._send_task.cancel()
        while not self._send_queue.empty():
            try:
                _priority, _order, _msg, future = self._send_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if not future.done():
                future.cancel()

    async def send(self, msg: dict):
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._send_sequence += 1
        try:
            await self._send_queue.put((self._message_priority(msg), self._send_sequence, msg, future))
            await future
        except Exception:
            pass

    def queue_latest(self, key: str, msg: dict) -> None:
        """Coalesce replaceable server-push snapshots behind the WS send lock.

        Streaming run updates contain the whole event projection. If encryption or
        the socket briefly falls behind, obsolete intermediate snapshots are worse
        than useless: they consume CPU/bandwidth before the newest state can arrive.
        Keep at most one unsent snapshot per logical stream.
        """
        self._latest_messages[key] = msg
        task = self._latest_tasks.get(key)
        if task is not None and not task.done():
            return

        async def drain() -> None:
            try:
                while key in self._latest_messages:
                    current = self._latest_messages.pop(key)
                    await self.send(current)
                    await asyncio.sleep(0)
            finally:
                self._latest_tasks.pop(key, None)
                # A message may have arrived between the final lookup and task
                # cleanup. Restart once so no latest state is stranded.
                if key in self._latest_messages:
                    self.queue_latest(key, self._latest_messages[key])

        self._latest_tasks[key] = asyncio.create_task(drain(), name=f"general-ws-latest:{key}")

    async def respond(self, req_id: str, msg_type: str, payload: Any):
        # One-way client pushes deliberately have no request id.  The encrypted
        # WebSocket is ordered/reliable already, so do not manufacture ACK frames.
        if not req_id:
            return
        await self.send({"id": req_id, "type": f"{msg_type}/response", "payload": payload})

    async def error(self, req_id: str, message: str):
        if not req_id:
            logger.warning("One-way General WS message failed: %s", message)
            return
        await self.send({"id": req_id, "type": "error", "payload": {"message": message}})

    async def handle_message(self, msg: dict):
        req_id   = str(msg.get("id") or "")
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
                chat_id = payload.get("chat_id") if isinstance(payload, dict) else None
                if msg_type == "runs/start" and isinstance(payload.get("chat"), dict):
                    chat_id = payload["chat"].get("id")
                if chat_id and msg_type not in {
                    "container/status", "terminal/slots", "runs/status", "terminal/active-chats",
                    "containers/chat-presence",
                }:
                    # Activity journaling is lifecycle bookkeeping, not part of
                    # the networking critical path. Never stall an RPC on its
                    # file lock / atomic JSON write.
                    asyncio.create_task(asyncio.to_thread(container_lifecycle.record_activity, chat_id, msg_type))
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
            # Delivered only inside the already-authenticated encrypted channel;
            # secondary terminal sockets and container proxies use this capability.
            await self.respond(req_id, "auth/login", {"ok": True, "session_token": token})
        else:
            await self.error(req_id, "Invalid server password")

    def _refresh_session_capability(self) -> str | None:
        """Keep/renew the secondary-socket capability for this authenticated WS.

        The General WS is the authenticated relationship.  Its bearer token is
        merely a capability used by subordinate sockets (terminal/proxy).  A
        token expiring while this encrypted, already-authenticated General WS is
        still alive must therefore be a cheap reconfirmation, not another
        Argon2 password login.
        """
        if not auth.server_requires_auth():
            self.session_token = None
            return None
        if self.session_token and auth.validate_session(self.session_token):
            return self.session_token
        if self.session_token:
            auth.revoke_session(self.session_token)
        self.session_token = auth.create_session(f"ws-general:{self.client_presence_id}")
        return self.session_token

    async def _client_proof_of_life(self, req_id: str, payload: dict):
        # This message arriving over SecureWebSocket is itself proof that the
        # Vulcan client/event loop and encrypted General WS are alive.  Refresh
        # the short-lived subordinate capability at the same time so a laptop
        # can sleep for hours and resume without surfacing an auth failure.
        token = self._refresh_session_capability()
        await self.respond(req_id, "client/proof-of-life", {
            "ok": True,
            "session_token": token,
        })

    async def _client_register(self, req_id: str, payload: dict):
        client_id = str(payload.get("client_id") or "").strip()
        if not client_id:
            raise ValueError("client_id is required")
        etna_registry.unregister_client(self.client_device_id, self)
        self.client_device_id = client_id
        etna_registry.register_client(client_id, self)
        await self.respond(req_id, "client/register", {"ok": True, "client_id": client_id})


    async def _client_state(self, req_id: str, payload: dict):
        client_id = self.client_device_id or str(payload.get("client_id") or "").strip()
        if not client_id:
            return
        key = str(payload.get("key") or "").strip()
        if not key:
            return
        etna_registry.set_client_state(client_id, key, payload.get("value"))
        await self.respond(req_id, "client/state", {"ok": True})

    async def _semantic_embed(self, req_id: str, payload: dict):
        texts = payload.get("texts", [])
        if not isinstance(texts, list) or len(texts) > 256 or any(not isinstance(text, str) for text in texts):
            raise ValueError("semantic/embed texts must be a list of at most 256 strings")
        if sum(len(text) for text in texts) > 2_000_000:
            raise ValueError("semantic/embed request is too large")
        from vulcan import recall
        if texts:
            vectors = await asyncio.to_thread(lambda: recall._normalize(list(recall.embedder().embed(texts))))
            result_vectors = [[float(value) for value in vector] for vector in vectors]
            dimensions = len(result_vectors[0]) if result_vectors else 0
        else:
            # Startup already performs a real ONNX inference. Reuse the warmed
            # encoder metadata without re-embedding a dummy document here.
            info = await asyncio.to_thread(recall.semantic_model_info)
            result_vectors = []
            dimensions = int(info["dimensions"])
        await self.respond(req_id, "semantic/embed", {
            "model": recall._MODEL_NAME,
            "dimensions": dimensions,
            "normalized": True,
            "vectors": result_vectors,
        })

    async def _etna_http_response(self, req_id: str, payload: dict):
        relay_id = str(payload.get("relay_id") or "")
        ok = etna_registry.resolve_relay(relay_id, payload)
        await self.respond(req_id, "etna/http-response", {"ok": ok})

    async def _client_http_event(self, req_id: str, payload: dict):
        relay_id = str(payload.get("relay_id") or "")
        ok = etna_registry.resolve_http_event(relay_id, payload)
        await self.respond(req_id, "client/http-event", {"ok": ok})

    async def _client_http_chunk(self, _req_id: str, payload: dict):
        # Stream data is intentionally one-way. The secure WebSocket preserves
        # message order; headers/done/error remain acknowledged control frames.
        relay_id = str(payload.get("relay_id") or "")
        etna_registry.resolve_http_event(relay_id, {"event": "chunk", "data": payload.get("data", "")})

    async def _design_action_response(self, req_id: str, payload: dict):
        relay_id = str(payload.get("relay_id") or "")
        ok = etna_registry.resolve_relay(relay_id, payload)
        await self.respond(req_id, "design/action-response", {"ok": ok})

    def _routes(self) -> dict:
        return {
            # Connection liveness / fast session reconfirmation
            "client/proof-of-life":        self._client_proof_of_life,
            "client/register":              self._client_register,
            "client/state":                 self._client_state,
            "semantic/embed":              self._semantic_embed,
            "etna/http-response":          self._etna_http_response,
            "client/http-event":             self._client_http_event,
            "client/http-chunk":             self._client_http_chunk,
            "design/action-response":         self._design_action_response,
            # Ping
            "ping":                        self._ping,
            # Server-owned background agent runs.
            "runs/start":                  self._runs_start,
            "runs/cancel":                 self._runs_cancel,
            "runs/subscribe":              self._runs_subscribe,
            "runs/answer":                 self._runs_answer,
            "runs/status":                 self._runs_status,
            "providers/models":            self._providers_models,
            "network/http-json":          self._network_http_json,
            "network/http-bytes":         self._network_http_bytes,
            # Chats
            "chats/list":                  self._chats_list,
            "chats/topics":                self._chats_topics,
            "chats/search":                self._chats_search,
            "chats/branch-search":         self._chats_branch_search,
            "chats/get":                   self._chats_get,
            "chats/export":                self._chats_export,
            "chats/upsert":                self._chats_upsert,
            "chats/delete":                self._chats_delete,
            "chat-folders/list":          self._chat_folders_list,
            "chat-folders/save":          self._chat_folders_save,
            # Shared file library
            "library/status":              self._library_status,
            "library/search":              self._library_search,
            "library/attach":              self._library_attach,
            # Terminal
            "terminal/slots":              self._terminal_slots,
            "terminal/active-chats":       self._terminal_active_chats,
            "terminal/slot/open":          self._terminal_slot_open,
            "terminal/slot/close":         self._terminal_slot_close,
            "terminal/slot/run":           self._terminal_slot_run,
            "terminal/slot/input":         self._terminal_slot_input,
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
            "git/restore-file":            self._git_restore_file,
            "git/changed":                 self._git_changed,
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
            "containers/inspect":          self._containers_inspect,
            "containers/lifecycle":        self._containers_lifecycle,
            "containers/lifecycle/update": self._containers_lifecycle_update,
            "containers/reap":             self._containers_reap,
            "containers/chat-presence":    self._containers_chat_presence,
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

    async def _library_status(self, req_id: str, p: dict):
        count = await asyncio.to_thread(library.inventory_count)
        await self.respond(req_id, "library/status", {"path": str(library.root()), "count": count})

    async def _library_search(self, req_id: str, p: dict):
        result = await asyncio.to_thread(library.search, str(p.get("query", "")), int(p.get("limit", 20)))
        await self.respond(req_id, "library/search", result)

    async def _library_attach(self, req_id: str, p: dict):
        result = await asyncio.to_thread(library.attach, str(p["chat_id"]), str(p["file_id"]), p.get("destination"))
        await self.respond(req_id, "library/attach", result)

    async def _network_http_json(self, req_id: str, p: dict):
        from vulcan import network
        url = str(p.get("url") or "").strip()
        if not url:
            raise ValueError("url is required")
        method = str(p.get("method") or "GET").upper()
        headers = p.get("headers") if isinstance(p.get("headers"), dict) else {}
        body = p.get("body")
        response = await network.request(
            method, url, headers=headers,
            json=body if body is not None and method != "GET" else None,
            retries=1,
        )
        text = response.text
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {text or response.reason_phrase}")
        try:
            payload = response.json() if text else {}
        except Exception:
            payload = {"result": text}
        await self.respond(req_id, "network/http-json", payload)

    async def _network_http_bytes(self, req_id: str, p: dict):
        """Binary-safe transient HTTP from the Vulcan server network namespace."""
        import base64
        from vulcan import network
        url = str(p.get("url") or "").strip()
        if not url:
            raise ValueError("url is required")
        method = str(p.get("method") or "GET").upper()
        headers = p.get("headers") if isinstance(p.get("headers"), dict) else {}
        body = p.get("body")
        response = await network.request(
            method, url, headers=headers,
            json=body if body is not None and method != "GET" else None,
            retries=1,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text or response.reason_phrase}")
        payload = {
            "status": response.status_code,
            "contentType": response.headers.get("content-type", "application/octet-stream"),
            "base64": base64.b64encode(response.content).decode("ascii"),
        }
        await self.respond(req_id, "network/http-bytes", payload)

    # ── Server-owned agent runs ───────────────────────────────────────────────

    async def _providers_models(self, req_id: str, p: dict):
        from vulcan import network
        candidate = p.get("provider") or {}
        base_url = candidate.get("baseUrl") or candidate.get("base_url")
        api_key = candidate.get("apiKey") or candidate.get("api_key")
        if not base_url:
            raise ValueError("No inference endpoint configured")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        response = await network.request(
            "GET", base_url.rstrip("/") + "/models",
            headers=headers, retries=1,
        )
        response.raise_for_status()
        data = response.json()
        await self.respond(req_id, "providers/models", {"data": data.get("data", [])})

    async def _runs_start(self, req_id: str, p: dict):
        chat = p.get("chat")
        if not isinstance(chat, dict) or not chat.get("id"):
            raise ValueError("Missing chat or chat.id")
        options = p.get("options") or {}
        if not isinstance(options, dict):
            raise ValueError("Invalid run options")
        supplied = options.get("provider")
        if not isinstance(supplied, dict) or not (supplied.get("baseUrl") or supplied.get("base_url")):
            raise ValueError("Missing transient provider configuration")
        pov = "server" if (supplied.get("networkPointOfView") or supplied.get("network_point_of_view")) == "server" else "client"
        options["provider"] = {
            "baseUrl": supplied.get("baseUrl") or supplied.get("base_url") or "",
            "apiKey": supplied.get("apiKey") or supplied.get("api_key") or "",
            "model": supplied.get("model") or "",
            "providerId": supplied.get("providerId") or supplied.get("id"),
            "name": supplied.get("name") or supplied.get("providerName") or "",
            "networkPointOfView": pov,
            "clientId": self.client_device_id if pov == "client" else None,
        }
        options["clientId"] = self.client_device_id
        # Canonical models.dev metadata wins. Unknown Ollama aliases are refined
        # in the background; /api/show metadata must never sit in front of the
        # provider request. Later turns/tools observe the resolved capability.
        if options.get("modelVision", "unknown") == "unknown":
            async def refine_ollama_vision() -> None:
                try:
                    resolved_vision = await agent_runtime.resolve_ollama_model_vision(options["provider"])
                    if resolved_vision is not None and resolved_vision != "unknown":
                        options["modelVision"] = resolved_vision
                except Exception:
                    logger.debug("Background Ollama capability refinement failed", exc_info=True)
            asyncio.create_task(refine_ollama_vision(), name=f"ollama-vision:{chat['id']}")
        # New chats keep the stable placeholder until the first agent response
        # completes. AgentRunManager then names the chat locally with the
        # deterministic user+assistant title classifier; provider inference is
        # never used for chat naming.
        run = await agent_runtime.MANAGER.start_async(chat, options, session=self)
        # Keep the acknowledgement tiny. The renderer already owns the submitted
        # transcript; live/final pushes carry authoritative changes after dispatch.
        await self.respond(req_id, "runs/start", {
            "chat_id": chat["id"], "run_id": run.run_id, "status": run.status,
        })

    async def _runs_cancel(self, req_id: str, p: dict):
        stopped = agent_runtime.MANAGER.cancel(p["chat_id"])
        await self.respond(req_id, "runs/cancel", {"ok": stopped})

    async def _runs_subscribe(self, req_id: str, p: dict):
        chat_id = p["chat_id"]
        agent_runtime.MANAGER.subscribe(chat_id, self)
        run = agent_runtime.MANAGER.runs.get(chat_id)
        chat = run.chat if run else await asyncio.to_thread(chat_store.load_chat, chat_id)
        await self.respond(req_id, "runs/subscribe", {
            "chat_id": chat_id, "chat": chat, "status": ("complete" if run and run.generation_complete else run.status) if run else "idle",
            "run_id": run.run_id if run else None, "question": run.question_batch if run else None,
        })

    async def _runs_answer(self, req_id: str, p: dict):
        agent_runtime.MANAGER.answer(p["chat_id"], p["batch_id"], p.get("answers", {}))
        await self.respond(req_id, "runs/answer", {"ok": True})

    async def _runs_status(self, req_id: str, p: dict):
        run = agent_runtime.MANAGER.runs.get(p["chat_id"])
        await self.respond(req_id, "runs/status", {
            "status": ("complete" if run and run.generation_complete else run.status) if run else "idle", "run_id": run.run_id if run else None,
            "question": run.question_batch if run else None,
        })

    # ── Chats ─────────────────────────────────────────────────────────────────

    async def _chats_list(self, req_id: str, p: dict):
        # r14 clients request a sidebar-only projection and hydrate one chat on
        # selection.  Keep the old full-list contract for older renderers.
        loader = chat_store.load_chat_summaries if p.get("summary_only") else chat_store.load_all_chats
        chat_list = await asyncio.to_thread(loader)
        await self.respond(req_id, "chats/list", {"chats": chat_list})

    async def _chats_topics(self, req_id: str, p: dict):
        tags = await asyncio.to_thread(chat_store.topic_tags)
        await self.respond(req_id, "chats/topics", {"tags": tags})

    async def _chats_search(self, req_id: str, p: dict):
        # Universal message search is intentionally one direct FTS path. Title,
        # auto-tag and folder matching already happen from sidebar metadata on the
        # client, so do not run a second SQLite search or merge two result sets.
        result = await asyncio.to_thread(
            chat_store.search_current_transcripts, str(p.get("query", ""))
        )
        await self.respond(req_id, "chats/search", result)

    async def _chats_branch_search(self, req_id: str, p: dict):
        result = await asyncio.to_thread(
            chat_store.search_branches, str(p.get("chat_id", "")), str(p.get("query", ""))
        )
        await self.respond(req_id, "chats/branch-search", result)

    async def _chats_get(self, req_id: str, p: dict):
        chat = await asyncio.to_thread(chat_store.load_chat, p["chat_id"])
        if chat is None:
            await self.error(req_id, "Chat not found")
        else:
            await self.respond(req_id, "chats/get", {"chat": chat})

    async def _chats_export(self, req_id: str, p: dict):
        chat_id = str(p["chat_id"])
        active = agent_runtime.MANAGER.runs.get(chat_id)
        chat = active.chat if active and active.task and not active.task.done() else await asyncio.to_thread(chat_store.load_chat, chat_id)
        if chat is None:
            await self.error(req_id, "Chat not found")
            return
        await self.respond(req_id, "chats/export", {"chat": chat})

    async def _chats_upsert(self, req_id: str, p: dict):
        chat = p.get("chat")
        if not chat or not chat.get("id"):
            await self.error(req_id, "Missing chat or chat.id")
            return
        active = agent_runtime.MANAGER.runs.get(chat["id"])
        if active and active.task and not active.task.done():
            # Legacy renderer metadata saves must never replace the event stream
            # currently being authored by the server-owned background task.
            for key, value in chat.items():
                if key not in ("events", "updatedAt", "tags"):
                    active.chat[key] = value
            await active.checkpoint()
            await self.respond(req_id, "chats/upsert", {"ok": True})
            return
        await asyncio.to_thread(chat_store.save_chat, chat)
        await self.respond(req_id, "chats/upsert", {"ok": True})

    async def _chats_delete(self, req_id: str, p: dict):
        deleted = await asyncio.to_thread(chat_store.delete_chat, p["chat_id"])
        if not deleted:
            await self.error(req_id, "Chat not found")
        else:
            await self.respond(req_id, "chats/delete", {"ok": True})

    async def _chat_folders_list(self, req_id: str, p: dict):
        folders = await asyncio.to_thread(folder_store.load_folders)
        await self.respond(req_id, "chat-folders/list", {"folders": folders})

    async def _chat_folders_save(self, req_id: str, p: dict):
        folders = p.get("folders")
        if not isinstance(folders, list):
            await self.error(req_id, "Missing folders list")
            return
        await asyncio.to_thread(folder_store.save_folders, folders)
        await self.respond(req_id, "chat-folders/save", {"ok": True})

    # ── Terminal ──────────────────────────────────────────────────────────────

    async def _terminal_slots(self, req_id: str, p: dict):
        slots = await asyncio.to_thread(term.list_slots, p["chat_id"])
        await self.respond(req_id, "terminal/slots", {"slots": slots})

    async def _terminal_active_chats(self, req_id: str, p: dict):
        chat_ids, statuses = await asyncio.gather(
            asyncio.to_thread(term.active_chat_ids),
            asyncio.to_thread(term.terminal_chat_statuses),
        )
        await self.respond(req_id, "terminal/active-chats", {
            "chat_ids": chat_ids,
            "statuses": statuses,
        })

    async def _terminal_slot_open(self, req_id: str, p: dict):
        try:
            slot = await asyncio.to_thread(
                term.open_slot, p["chat_id"], p.get("kind", "user"), p.get("slot")
            )
            await self.respond(req_id, "terminal/slot/open", {"slot": slot})
        except (ValueError, RuntimeError) as e:
            await self.error(req_id, str(e))

    async def _terminal_slot_close(self, req_id: str, p: dict):
        await asyncio.to_thread(term.close_slot, p["chat_id"], p["kind"], int(p["slot"]))
        await self.respond(req_id, "terminal/slot/close", {"ok": True})

    async def _terminal_slot_run(self, req_id: str, p: dict):
        try:
            raw_timeout = p.get("timeout", 180)
            timeout = None if raw_timeout is None else int(raw_timeout)
            pid = await asyncio.to_thread(
                term.use_terminal_in_slot,
                p["chat_id"], p.get("kind", "agent"), int(p["slot"]),
                p["cmd"], timeout
            )
            await self.respond(req_id, "terminal/slot/run", {"pid": pid})
        except RuntimeError as e:
            await self.error(req_id, str(e))

    async def _terminal_slot_input(self, req_id: str, p: dict):
        try:
            if "key" in p:
                value = term.encode_terminal_key(p["key"], p.get("modifiers"))
            else:
                value = p["text"] + ("\r" if p.get("submit", False) else "")
            ok = term.send_slot_input(p["chat_id"], p.get("kind", "agent"), int(p["slot"]), value)
            await self.respond(req_id, "terminal/slot/input", {"ok": ok})
        except (KeyError, TypeError, ValueError) as error:
            await self.error(req_id, str(error))

    async def _terminal_slot_output(self, req_id: str, p: dict):
        output = await asyncio.to_thread(
            term.read_slot_output, p["chat_id"], p["kind"], int(p["slot"]), int(p.get("lines", 50))
        )
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
            content = await asyncio.to_thread(workspace.read_file, p["chat_id"], p["path"])
            await self.respond(req_id, "workspace/read-file", {"content": content})
        except FileNotFoundError as e:
            await self.error(req_id, str(e))

    async def _workspace_write_file(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.write_file, p["chat_id"], p["path"], p.get("content", ""))
        await self.respond(req_id, "workspace/write-file", {"ok": True})

    async def _workspace_create_directory(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.create_directory, p["chat_id"], p["path"])
        await self.respond(req_id, "workspace/create-directory", {"ok": True})

    async def _workspace_edit_file(self, req_id: str, p: dict):
        result = await asyncio.to_thread(workspace.edit_file, p["chat_id"], p["path"], p.get("edits", []))
        await self.respond(req_id, "workspace/edit-file", result)

    async def _workspace_find_in_file(self, req_id: str, p: dict):
        matches = await asyncio.to_thread(workspace.find_in_file, p["chat_id"], p["path"], p.get("query", ""))
        await self.respond(req_id, "workspace/find-in-file", {"matches": matches})

    async def _workspace_read_file_base64(self, req_id: str, p: dict):
        result = await asyncio.to_thread(workspace.read_file_base64, p["chat_id"], p["path"])
        b64, mime = result
        await self.respond(req_id, "workspace/read-file-base64", {"base64": b64, "mimeType": mime})

    async def _workspace_list_files(self, req_id: str, p: dict):
        files = await asyncio.to_thread(workspace.list_files, p["chat_id"])
        await self.respond(req_id, "workspace/list-files", {"files": files})

    async def _workspace_path(self, req_id: str, p: dict):
        path = str(cfg.chat_workspace_dir(p["chat_id"]))
        await self.respond(req_id, "workspace/path", {"path": path})

    async def _workspace_present(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.present_file, p["chat_id"], p["path"])
        await self.respond(req_id, "workspace/present", {"ok": True})

    async def _workspace_rename_file(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.rename_path, p["chat_id"], p["old_path"], p["new_path"])
        await self.respond(req_id, "workspace/rename-file", {"ok": True})

    async def _workspace_delete_file(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.delete_path, p["chat_id"], p["path"])
        await self.respond(req_id, "workspace/delete-file", {"ok": True})

    async def _workspace_download_folder(self, req_id: str, p: dict):
        import base64
        raw = await asyncio.to_thread(workspace.zip_folder, p["chat_id"], p.get("path", "/workspace"))
        await self.respond(req_id, "workspace/download-folder", {"base64": base64.b64encode(raw).decode()})

    async def _workspace_export(self, req_id: str, p: dict):
        import base64
        raw, filename, mime_type = await asyncio.to_thread(workspace.export_workspace_item, p["chat_id"], p["path"])
        await self.respond(req_id, "workspace/export", {
            "base64": base64.b64encode(raw).decode("ascii"),
            "filename": filename,
            "mimeType": mime_type,
        })

    async def _workspace_export_prepare(self, req_id: str, p: dict):
        raw, filename, mime_type = await asyncio.to_thread(workspace.export_workspace_item, p["chat_id"], p["path"])
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
        is_library = bool(p.get("library", False))
        expected = int(p.get("size", 0))
        if not chat_id and not is_library:
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
            if is_library:
                final_path, public_path, is_workspace = library.upload_destination(filename)
            else:
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
            "library": is_library,
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
            "library": bool(state.get("library")),
            **({"file": library.describe(Path(state["final_path"]))} if state.get("library") else {}),
            "received": state["received"],
        })

    async def _attachment_upload_cancel(self, req_id: str, p: dict):
        state = self._uploads.pop(str(p.get("upload_id", "")), None)
        if state is not None:
            self._cleanup_upload_state(state)
        await self.respond(req_id, "attachment/upload/cancel", {"ok": True})

    # ── Git ───────────────────────────────────────────────────────────────────

    async def _git_log(self, req_id: str, p: dict):
        log = await asyncio.to_thread(workspace.git_log, p["chat_id"], p.get("path"))
        await self.respond(req_id, "git/log", {"log": log})

    async def _git_show(self, req_id: str, p: dict):
        result = await asyncio.to_thread(workspace.git_show, p["chat_id"], p["hash"], p.get("path", ""))
        await self.respond(req_id, "git/show", {"content": result})

    async def _git_commit(self, req_id: str, p: dict):
        result = await asyncio.to_thread(workspace.git_commit, p["chat_id"], p["message"], p.get("paths"))
        await self.respond(req_id, "git/commit", {"ok": True, "hash": result})

    async def _git_restore(self, req_id: str, p: dict):
        result = await asyncio.to_thread(workspace.git_restore, p["chat_id"], p["hash"])
        await self.respond(req_id, "git/restore", {"output": result})

    async def _git_restore_file(self, req_id: str, p: dict):
        result = await asyncio.to_thread(workspace.git_restore_file, p["chat_id"], p["hash"], p["path"], actor="user")
        await self.respond(req_id, "git/restore-file", result)

    async def _git_changed(self, req_id: str, p: dict):
        changed = await asyncio.to_thread(workspace.has_changed_since_last_commit, p["chat_id"], p["path"])
        await self.respond(req_id, "git/changed", {"changed": changed})

    # ── Snapshots ─────────────────────────────────────────────────────────────

    async def _snapshot_save(self, req_id: str, p: dict):
        snap_id = await asyncio.to_thread(workspace.save_snapshot, p["chat_id"], p["path"])
        await self.respond(req_id, "snapshot/save", {"id": snap_id})

    async def _snapshot_list(self, req_id: str, p: dict):
        snaps = await asyncio.to_thread(workspace.list_snapshots, p["chat_id"], p["path"])
        await self.respond(req_id, "snapshot/list", {"snapshots": snaps})

    async def _snapshot_show(self, req_id: str, p: dict):
        content = await asyncio.to_thread(workspace.get_snapshot_content, p["chat_id"], p["id"], p["path"])
        await self.respond(req_id, "snapshot/show", {"content": content})

    # ── Workspace management ──────────────────────────────────────────────────

    async def _workspace_list_all(self, req_id: str, p: dict):
        workspaces = await asyncio.to_thread(workspace.list_workspaces)
        await self.respond(req_id, "workspace/list-all", {"workspaces": workspaces})

    async def _workspace_delete(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.delete_workspace, p["chat_id"])
        await self.respond(req_id, "workspace/delete", {"ok": True})

    # ── Container ─────────────────────────────────────────────────────────────

    async def _container_status(self, req_id: str, p: dict):
        status = await asyncio.to_thread(docker.status, p["chat_id"])
        await self.respond(req_id, "container/status", status)

    async def _container_start(self, req_id: str, p: dict):
        ok = await asyncio.to_thread(docker.start_container, p["chat_id"])
        if ok:
            container_lifecycle.record_activity(p["chat_id"], "manual-start")
        await self.respond(req_id, "container/start", {"ok": ok})

    async def _container_stop(self, req_id: str, p: dict):
        result = await asyncio.to_thread(
            container_lifecycle.stop_container,
            p["chat_id"],
            reason="manual",
            force=bool(p.get("force", False)),
        )
        await self.respond(req_id, "container/stop", result)

    async def _container_reset(self, req_id: str, p: dict):
        await asyncio.to_thread(docker.reset_container, p["chat_id"])
        await self.respond(req_id, "container/reset", {"ok": True})

    async def _container_nuke(self, req_id: str, p: dict):
        await asyncio.to_thread(docker.nuke_chat, p["chat_id"])
        await self.respond(req_id, "container/nuke", {"ok": True})

    async def _containers_running(self, req_id: str, p: dict):
        running = await asyncio.to_thread(docker.list_running_containers)
        await self.respond(req_id, "containers/running", {"chat_ids": running})

    async def _containers_inspect(self, req_id: str, p: dict):
        containers = await asyncio.to_thread(container_lifecycle.inspect_running_containers)
        await self.respond(req_id, "containers/inspect", {
            "containers": containers,
            "policy": container_lifecycle.policy(),
        })

    async def _containers_lifecycle(self, req_id: str, p: dict):
        await self.respond(req_id, "containers/lifecycle", {"policy": container_lifecycle.policy()})

    async def _containers_lifecycle_update(self, req_id: str, p: dict):
        values = p.get("policy", p)
        policy = await asyncio.to_thread(container_lifecycle.update_policy, values)
        await self.respond(req_id, "containers/lifecycle/update", {"policy": policy})

    async def _containers_reap(self, req_id: str, p: dict):
        result = await asyncio.to_thread(container_lifecycle.reap_idle_containers)
        await self.respond(req_id, "containers/reap", result)

    async def _containers_chat_presence(self, req_id: str, p: dict):
        chat_id = p.get("chat_id")
        if chat_id is not None and not isinstance(chat_id, str):
            raise ValueError("chat_id must be a string or null")
        container_lifecycle.set_client_chat(self.client_presence_id, chat_id)
        await self.respond(req_id, "containers/chat-presence", {"ok": True, "chat_id": chat_id})

    # ── Dashboards ────────────────────────────────────────────────────────────

    async def _dashboard_create(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.dashboard_create, p["chat_id"], p["name"], p.get("html", ""), p.get("css", ""), p.get("js", ""), actor="user")
        await self.respond(req_id, "dashboard/create", {"ok": True})

    async def _dashboard_update(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.dashboard_update, p["chat_id"], p["name"], p["part"], p.get("content", ""), actor="user")
        await self.respond(req_id, "dashboard/update", {"ok": True})

    async def _dashboard_inspect(self, req_id: str, p: dict):
        content = await asyncio.to_thread(workspace.dashboard_inspect, p["chat_id"], p["name"], p["part"])
        await self.respond(req_id, "dashboard/inspect", {"content": content})

    async def _dashboard_list(self, req_id: str, p: dict):
        dashboards = await asyncio.to_thread(workspace.dashboard_list, p["chat_id"])
        await self.respond(req_id, "dashboard/list", {"dashboards": dashboards})

    async def _dashboard_get(self, req_id: str, p: dict):
        html = await asyncio.to_thread(workspace.dashboard_get_html, p["chat_id"], p["name"])
        await self.respond(req_id, "dashboard/get", {"html": html})

    async def _dashboard_delete(self, req_id: str, p: dict):
        await asyncio.to_thread(workspace.dashboard_delete, p["chat_id"], p["name"], actor="user")
        await self.respond(req_id, "dashboard/delete", {"ok": True})

    # ── Blob store ────────────────────────────────────────────────────────────

    async def _blobs_store(self, req_id: str, p: dict):
        blob_id   = p.get("id")
        blob_data = p.get("data")
        if not blob_id or blob_data is None:
            await self.error(req_id, "Missing id or data")
            return
        with _BLOBS_LOCK:
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
        with _BLOBS_LOCK:
            blobs = _load_blobs()
            if blob_id in blobs:
                del blobs[blob_id]
                _save_blobs(blobs)
        await self.respond(req_id, "blobs/delete", {"ok": True})


# ── Main WebSocket handler ────────────────────────────────────────────────────

# Messages in this set are latency/order-sensitive and intentionally complete in
# the receive loop.  Everything else gets bounded concurrent dispatch so a slow
# disk/network RPC cannot head-of-line-block provider chunks or proof-of-life.
_INLINE_MESSAGE_TYPES = frozenset({
    "auth/login",
    "client/proof-of-life",
    "client/register",
    "client/state",
    "client/http-event",
    "client/http-chunk",
    "etna/http-response",
    "design/action-response",
    "runs/cancel",
})
_GENERAL_CONCURRENCY = 32
_CRITICAL_CONCURRENCY = 8
_CRITICAL_MESSAGE_TYPES = frozenset({
    "runs/start", "runs/cancel", "client/proof-of-life", "workspace/path",
    "terminal/slots", "runs/status", "runs/answer",
})
_SLOW_HANDLER_SECONDS = 0.250


async def handle(ws: WebSocket):
    secure_ws = await SecureWebSocketSession.accept(ws)
    session = GeneralWSSession(secure_ws)
    dispatch_slots = asyncio.Semaphore(_GENERAL_CONCURRENCY)
    critical_slots = asyncio.Semaphore(_CRITICAL_CONCURRENCY)
    tasks: set[asyncio.Task] = set()

    # Authentication begins only after the encrypted session is established.
    requires_auth = auth.server_requires_auth()
    await session.send({
        "type": "push/connected",
        "payload": {"requires_auth": requires_auth, "version": "0.1.0", "encrypted": True},
    })

    async def dispatch(message: dict) -> None:
        msg_type = str(message.get("type") or "")
        started = time.perf_counter()
        try:
            gate = critical_slots if msg_type in _CRITICAL_MESSAGE_TYPES else dispatch_slots
            async with gate:
                await session.handle_message(message)
        finally:
            elapsed = time.perf_counter() - started
            if elapsed >= _SLOW_HANDLER_SECONDS:
                logger.warning("General WS handler %s took %.3fs", msg_type or "<unknown>", elapsed)

    try:
        while True:
            message = await secure_ws.receive_json()
            if not isinstance(message, dict):
                raise ValueError("Secure application message must be an object")
            msg_type = str(message.get("type") or "")
            # Auth must be serialized until established. Relay/control traffic is
            # kept inline to minimize jitter and preserve arrival order exactly.
            if not session.authenticated or msg_type in _INLINE_MESSAGE_TYPES:
                started = time.perf_counter()
                await session.handle_message(message)
                elapsed = time.perf_counter() - started
                if elapsed >= _SLOW_HANDLER_SECONDS:
                    logger.warning("Inline General WS handler %s took %.3fs", msg_type or "<unknown>", elapsed)
                continue
            task = asyncio.create_task(dispatch(message), name=f"general-ws:{msg_type or 'unknown'}")
            tasks.add(task)
            task.add_done_callback(tasks.discard)
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
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        session.cleanup()
