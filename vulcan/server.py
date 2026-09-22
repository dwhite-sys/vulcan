"""
vulcan/server.py — Vulcan FastAPI server

Shell endpoints (persistent bash PTY):
  POST /terminal/shell        { chat_id }              → { pid }
  GET  /terminal/shell/stream ?chat_id=                → SSE all output
  POST /terminal/input        { pid, text }            → { ok }
  POST /terminal/resize       { chat_id, cols, rows }  → { ok }

Command endpoints (one-shot piped):
  POST /terminal/run          { chat_id, cmd, timeout?, background? } → { pid }
  GET  /terminal/result       ?pid=                    → { output, finished, exit_code }
  POST /terminal/detach       { pid, reason? }         → { ok }
  POST /terminal/kill         { pid }                  → { ok }

Wait endpoints:
  POST /terminal/wait         { chat_id, seconds, webhook_url? } → { pid }
  ANY  /webhook/{name}        wake matching wait(webhook_url=...)

Workspace endpoints:
  GET  /workspace/file        ?chat_id=&path=          → { content }
  POST /workspace/file        { chat_id, path, content } → { ok }
  GET  /workspace/file/base64 ?chat_id=&path=          → { base64, mime_type }
  GET  /workspace/files       ?chat_id=                → { files }
  POST /workspace/present     { chat_id, path }        → { ok, hash }
  GET  /workspace/git/log     ?chat_id=&path=          → { commits }
  GET  /workspace/git/show    ?chat_id=&hash=&path=    → { content }
  POST /workspace/git/commit  { chat_id, message }     → { hash }
  POST /workspace/git/restore { chat_id, hash }        → { hash }
  POST /workspace/snapshot    { chat_id, path }        → { snapshot_id }
  GET  /workspace/snapshots   ?chat_id=&path=          → { snapshots }
  GET  /workspace/snapshot/show ?chat_id=&id=&path=    → { content }
  GET  /workspace/list                                 → { workspaces }
  POST /workspace/delete      { chat_id }              → { ok }

Container endpoints:
  GET  /container/status                               → { running, ... }
  POST /container/start                                → { ok }
  POST /container/stop                                 → { ok }
  POST /container/rebuild                              → { ok }

Status:
  GET  /ping                                           → { ok }
  GET  /status                                         → { ... }
"""

import json
import asyncio
import ipaddress
import os
import re
import secrets
import time
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from pathlib import PurePosixPath
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, RedirectResponse

from vulcan import config as cfg
from vulcan import container_lifecycle, docker, workspace, chats, recall, network
from vulcan import terminal as term
from vulcan import auth
from vulcan import ws_terminal
from vulcan import ws_general

app = FastAPI(title="Vulcan")

async def _retire_obsolete_global_container():
    """Remove old DNS/gateway infrastructure after switching to host networking."""
    try:
        await asyncio.to_thread(docker.retire_legacy_global_container)
    except Exception:
        import logging
        logging.getLogger("vulcan").exception("Could not remove obsolete global container")


async def _warm_semantic_model():
    """Load BGE-small and run one inference before Vulcan reports ready."""
    import logging

    logger = logging.getLogger("vulcan.recall")
    try:
        result = await asyncio.to_thread(recall.download_semantic_model)
        logger.info("Semantic recall ready at startup: %s", result["model"])
        return result
    except Exception:
        # Semantic search is optional: preserve Vulcan startup and let callers
        # degrade to lexical retrieval if the local model cannot initialize.
        logger.exception("Semantic model warmup failed; Vulcan remains available")
        return None


async def _prepare_recall_models():
    """Prepare the lexical bank/indexing after the semantic encoder is warm."""
    import logging

    logger = logging.getLogger("vulcan.recall")
    try:
        lexical = await asyncio.to_thread(recall.build_lexical_bank)
        recall.start_message_indexing()
        logger.info("Lexical recall ready: %s", lexical["path"])
    except Exception:
        logger.exception("Lexical recall preparation failed; Vulcan remains available")


AUTO_CHECKPOINT_INTERVAL_SECONDS = 300


async def _checkpoint_workspaces():
    """Preserve terminal and other unattributed changes every five minutes."""
    import logging

    logger = logging.getLogger("vulcan.workspace")
    while True:
        await asyncio.sleep(AUTO_CHECKPOINT_INTERVAL_SECONDS)
        try:
            candidates = list(cfg.CHATS_DIR.iterdir()) if cfg.CHATS_DIR.is_dir() else []
            for directory in candidates:
                if not directory.is_dir() or not (directory / "workspace").is_dir():
                    continue
                try:
                    await asyncio.to_thread(workspace.git_commit_auto, directory.name, "periodic workspace checkpoint")
                except Exception:
                    logger.exception("Automatic workspace checkpoint failed for %s", directory.name)
        except Exception:
            logger.exception("Automatic workspace checkpoint scan failed")


async def _manage_container_lifecycle():
    """Stop only idle chat containers; preserve active work and service processes."""
    import logging

    logger = logging.getLogger("vulcan.containers")
    while True:
        try:
            interval = container_lifecycle.policy()["reap_interval_seconds"]
            await asyncio.sleep(interval)
            result = await asyncio.to_thread(container_lifecycle.reap_idle_containers)
            if result["stopped"]:
                logger.info("Stopped idle chat containers: %s", ", ".join(result["stopped"]))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Container lifecycle scan failed; active containers remain running")
            await asyncio.sleep(30)


@app.on_event("startup")
async def _startup():
    # Provider and Etna endpoint definitions are client-owned as of protocol v5.
    # Purge stale registries written by development builds so the server can never
    # become a second, contradictory source of truth.
    config = cfg.load()
    stale = ("providers", "inference", "etna_servers", "etna_routes")
    if any(key in config for key in stale):
        for key in stale:
            config.pop(key, None)
        cfg.save(config)
    if auth.server_requires_auth():
        import logging
        logging.getLogger("vulcan").info("Server password is set — authentication required")
    # BGE-small backs both semantic recall and hybrid tool discovery. Warm it
    # before startup completes. Tool-corpus vectors are persisted by the client;
    # search_tools therefore embeds only its query at runtime.
    await _warm_semantic_model()
    # docker-exec PTYs cannot be reattached after the in-memory registry is lost.
    # Reap them before clients reconnect so one logical slot always maps to one shell.
    await asyncio.to_thread(docker.reconcile_orphan_terminal_processes)
    asyncio.create_task(_retire_obsolete_global_container())
    asyncio.create_task(_prepare_recall_models())
    asyncio.create_task(_checkpoint_workspaces())
    asyncio.create_task(_manage_container_lifecycle())


@app.on_event("shutdown")
async def _shutdown_network():
    await network.close_current_client()


app.add_middleware(CORSMiddleware,
                   allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "null"],
                   allow_methods=["*"], allow_headers=["*"])


def _loopback_client(host: str | None) -> bool:
    if not host:
        return False
    if host in ("localhost", "testclient"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _request_token(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.query_params.get("vulcan_session", "")


@app.middleware("http")
async def _protect_legacy_http(request: Request, call_next):
    # The encrypted general WebSocket remains the primary application transport.
    # Legacy HTTP routes must obey the same server-password boundary.
    if request.url.path in ("/ping", "/meta", "/auth/status") or request.method == "OPTIONS":
        return await call_next(request)
    if auth.server_requires_auth():
        if not auth.validate_session(_request_token(request)):
            return JSONResponse({"error": "Authenticated Vulcan session required"}, status_code=401)
    elif not _loopback_client(request.client.host if request.client else None):
        return JSONResponse({"error": "Remote access requires a Vulcan server password"}, status_code=403)
    return await call_next(request)


def ok(**kw):  return {"ok": True, **kw}
def err(msg, status=400): return JSONResponse({"error": msg}, status_code=status)


# ── Status ────────────────────────────────────────────────────────────────────

VULCAN_PROTOCOL_VERSION = 5
VULCAN_CAPABILITIES = [
    "etna.multi_server",
    "etna.client_relay",
    "provider.per_entry_pov",
    "provider.client_relay",
    "provider.client_streaming",
    "runs.cancel_immediate",
    "config.client_owned_network",
    "network.transient_http",
]


@app.get("/ping")
def ping(): return {"ok": True}


@app.get("/meta")
def meta():
    """Deterministic client/setup compatibility identity for this server process."""
    return {
        "ok": True,
        "protocolVersion": VULCAN_PROTOCOL_VERSION,
        "buildId": os.environ.get("VULCAN_BUILD_ID", "development"),
        "capabilities": VULCAN_CAPABILITIES,
    }

@app.get("/auth/status")
def auth_status(request: Request):
    """Expose authentication and whether this caller may open a server session."""
    requires_auth = auth.server_requires_auth()
    remote_access_allowed = requires_auth or _loopback_client(
        request.client.host if request.client else None
    )
    return {
        "requires_auth": requires_auth,
        "remote_access_allowed": remote_access_allowed,
    }

@app.get("/status")
def status():
    config = cfg.load()
    return {"version": "0.1.0", "port": config.get("port", cfg.DEFAULT_PORT),
            "network_mode": "host"}


# ── Chats ─────────────────────────────────────────────────────────────────────

@app.get("/chats")
def list_chats():
    try: return {"chats": chats.load_all_chats()}
    except Exception as e: return err(str(e))

@app.get("/chats/{chat_id}")
def get_chat(chat_id: str):
    chat = chats.load_chat(chat_id)
    if chat is None: return err("Chat not found", 404)
    return {"chat": chat}

@app.put("/chats/{chat_id}")
async def upsert_chat(chat_id: str, req: Request):
    body = await req.json()
    if body.get("id") != chat_id: return err("chat_id mismatch")
    try: return {"chat": chats.save_chat(body)}
    except ValueError as e: return err(str(e))
    except Exception as e: return err(str(e), 500)

@app.delete("/chats/{chat_id}")
def remove_chat(chat_id: str):
    deleted = chats.delete_chat(chat_id)
    if not deleted: return err("Chat not found", 404)
    return ok()


# ── Shell ─────────────────────────────────────────────────────────────────────

@app.post("/terminal/shell")
async def terminal_shell(req: Request):
    body = await req.json()
    chat_id = body.get("chat_id")
    if not chat_id: return err("Missing chat_id")
    if not docker.container_running(chat_id):
        if not docker.start_container(chat_id):
            return err("Container not running and could not be started", 503)
    pid = term.start_shell(chat_id)
    return {"pid": pid}

@app.get("/terminal/shell/stream")
async def terminal_shell_stream(chat_id: str):
    async def events():
        async for chunk in term.stream_shell(chat_id):
            yield f"data: {json.dumps({'chunk': chunk})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"
    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})

@app.post("/terminal/input")
async def terminal_input(req: Request):
    body = await req.json()
    pid  = body.get("pid")
    text = body.get("text", "")
    if not pid: return err("Missing pid")
    return {"ok": term.send_input(pid, text)}

@app.post("/terminal/resize")
async def terminal_resize(req: Request):
    body    = await req.json()
    chat_id = body.get("chat_id")
    cols    = int(body.get("cols", 80))
    rows    = int(body.get("rows", 24))
    if not chat_id: return err("Missing chat_id")
    term.resize_shell(chat_id, cols, rows)
    return ok()


# ── Commands ──────────────────────────────────────────────────────────────────

@app.post("/terminal/run")
async def terminal_run(req: Request):
    body       = await req.json()
    chat_id    = body.get("chat_id")
    cmd        = body.get("cmd")
    timeout    = int(body.get("timeout", 180))
    background = bool(body.get("background", False))
    if not chat_id or not cmd: return err("Missing chat_id or cmd")
    if not docker.container_running(chat_id):
        if not docker.start_container(chat_id):
            return err("Container not running and could not be started", 503)
    pid = term.use_terminal(chat_id, cmd, timeout=timeout, background=background)
    return {"pid": pid}

@app.get("/terminal/result")
def terminal_result(pid: str):
    cp = term.get_command(pid)
    wp = term.get_wait(pid) if not cp else None
    if cp:
        return {"pid": pid, "output": "".join(cp.output).strip(),
                "finished": cp.finished, "exit_code": cp.exit_code,
                "detached": cp.detached, "detach_reason": cp.detach_reason}
    if wp:
        return {"pid": pid, "output": f"Waited {wp.seconds}s.",
                "finished": wp.finished, "exit_code": 0,
                "detached": wp.detached, "detach_reason": wp.detach_reason,
                "wake_reason": wp.wake_reason,
                "webhook_method": wp.webhook_method,
                "webhook_path": wp.webhook_path}
    return err(f"Unknown pid: {pid}", 404)

@app.post("/terminal/detach")
async def terminal_detach(req: Request):
    body   = await req.json()
    pid    = body.get("pid")
    reason = body.get("reason", "")
    if not pid: return err("Missing pid")
    ok1 = term.detach_process(pid, reason)
    ok2 = term.detach_wait(pid, reason) if not ok1 else False
    return {"ok": ok1 or ok2}

@app.post("/terminal/kill")
async def terminal_kill(req: Request):
    body = await req.json()
    pid  = body.get("pid")
    if not pid: return err("Missing pid")
    return {"ok": term.kill_process(pid)}

@app.post("/terminal/wait")
async def terminal_wait(req: Request):
    body    = await req.json()
    chat_id = body.get("chat_id")
    seconds = float(body.get("seconds", 5))
    webhook_url = body.get("webhook_url")
    if not chat_id: return err("Missing chat_id")
    try:
        pid = term.start_wait(chat_id, seconds, webhook_url)
    except ValueError as error:
        return err(str(error))
    return {"pid": pid}


@app.api_route("/webhook/{hook_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def wait_webhook(req: Request, hook_path: str):
    path = f"/webhook/{hook_path}".rstrip("/")
    triggered = term.trigger_webhook(path, req.method)
    return {"ok": True, "triggered": triggered}


# ── Terminal WebSocket ────────────────────────────────────────────────────────

@app.websocket("/ws/terminal/{chat_id}/{kind}/{slot}")
async def terminal_ws(websocket: WebSocket, chat_id: str, kind: str, slot: int):
    """
    WebSocket per terminal slot. Replaces SSE stream + REST input/resize.
    kind: 'agent' | 'user'
    slot: 1-3
    """
    if not auth.server_requires_auth() and not _loopback_client(websocket.client.host if websocket.client else None):
        await websocket.close(code=1008, reason="Remote access requires a server password")
        return
    await ws_terminal.handle(websocket, chat_id, kind, slot)


@app.websocket("/ws/general")
async def general_ws(websocket: WebSocket):
    """
    General WebSocket — replaces REST API for all non-streaming operations.
    One connection per Electron session. Authenticated if server has a password.
    """
    if not auth.server_requires_auth() and not _loopback_client(websocket.client.host if websocket.client else None):
        await websocket.close(code=1008, reason="Remote access requires a server password")
        return
    await ws_general.handle(websocket)


# ── Terminal slot management ──────────────────────────────────────────────────

@app.get("/terminal/slots")
def terminal_slots_list(chat_id: str):
    try: return {"slots": term.list_slots(chat_id)}
    except Exception as e: return err(str(e))

@app.post("/terminal/slot/open")
async def terminal_slot_open(req: Request):
    b = await req.json()
    chat_id = b.get("chat_id")
    kind    = b.get("kind", "user")
    if not chat_id: return err("Missing chat_id")
    if kind not in ("agent", "user"): return err("kind must be 'agent' or 'user'")
    try:
        slot = term.open_slot(chat_id, kind)
        return ok(slot=slot)
    except ValueError as e: return err(str(e))

@app.post("/terminal/slot/close")
async def terminal_slot_close(req: Request):
    b = await req.json()
    chat_id = b.get("chat_id")
    kind    = b.get("kind")
    slot    = b.get("slot")
    if not all([chat_id, kind, slot]): return err("Missing fields")
    term.close_slot(chat_id, kind, int(slot))
    return ok()

@app.post("/terminal/slot/run")
async def terminal_slot_run(req: Request):
    b       = await req.json()
    chat_id = b.get("chat_id")
    kind    = b.get("kind", "agent")
    slot    = b.get("slot")
    cmd     = b.get("cmd")
    raw_timeout = b.get("timeout", 180)
    timeout = None if raw_timeout is None else int(raw_timeout)
    if not all([chat_id, slot, cmd]): return err("Missing fields")
    try:
        pid = term.use_terminal_in_slot(chat_id, kind, int(slot), cmd, timeout)
        return ok(pid=pid)
    except RuntimeError as e: return err(str(e))

@app.get("/terminal/slot/output")
def terminal_slot_output(chat_id: str, kind: str, slot: int, lines: int = 50):
    output = term.read_slot_output(chat_id, kind, int(slot), lines)
    return {"output": output}

@app.get("/terminal/slot/scrollback")
def terminal_slot_scrollback_get(chat_id: str, kind: str, slot: int):
    scrollback = term.get_slot_scrollback(chat_id, kind, slot)
    return {"scrollback": scrollback}

@app.post("/terminal/slot/scrollback")
async def terminal_slot_scrollback_set(req: Request):
    b = await req.json()
    chat_id    = b.get("chat_id")
    kind       = b.get("kind")
    slot       = b.get("slot")
    scrollback = b.get("scrollback", "")
    if not all([chat_id, kind, slot]): return err("Missing fields")
    term.save_slot_scrollback(chat_id, kind, int(slot), scrollback)
    return ok()


# ── Workspace — files ─────────────────────────────────────────────────────────

@app.get("/workspace/file")
def get_file(chat_id: str, path: str):
    try: return {"content": workspace.read_file(chat_id, path)}
    except FileNotFoundError as e: return err(str(e), 404)
    except ValueError as e: return err(str(e))

@app.post("/workspace/file")
async def write_file(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("path"): return err("Missing fields")
    try: workspace.write_file(b["chat_id"], b["path"], b.get("content",""))
    except ValueError as e: return err(str(e))
    except (PermissionError, OSError) as e: return err(f"{type(e).__name__}: {e}", 500)
    return ok()

@app.post("/workspace/file/edit")
async def edit_file(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("path") or not isinstance(b.get("edits"), list): return err("Missing fields")
    try:
        return workspace.edit_file(b["chat_id"], b["path"], b["edits"])
    except FileNotFoundError as e: return err(str(e), 404)
    except ValueError as e: return err(str(e))
    except Exception as e: return err(str(e), 500)

@app.get("/workspace/file/find")
def find_in_file(chat_id: str, path: str, query: str):
    try: return {"matches": workspace.find_in_file(chat_id, path, query)}
    except FileNotFoundError as e: return err(str(e), 404)
    except ValueError as e: return err(str(e))
    except Exception as e: return err(str(e), 500)

@app.get("/workspace/file/base64")
def get_file_b64(chat_id: str, path: str):
    try:
        b64, mime = workspace.read_file_base64(chat_id, path)
        return {"base64": b64, "mime_type": mime}
    except FileNotFoundError as e: return err(str(e), 404)
    except ValueError as e: return err(str(e))

@app.get("/workspace/files")
def list_files(chat_id: str):
    try: return {"files": workspace.list_files(chat_id)}
    except Exception as e: return err(str(e))

@app.get("/workspace/path")
def workspace_path(chat_id: str):
    """Return the host filesystem path of the chat workspace, for opening in file explorer."""
    try: return {"path": str(cfg.chat_workspace_dir(chat_id))}
    except Exception as e: return err(str(e))

@app.post("/workspace/present")
async def present_file(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("path"): return err("Missing fields")
    try: return ok(hash=workspace.present_file(b["chat_id"], b["path"]))
    except Exception as e: return err(str(e))

@app.post("/workspace/rename")
async def rename_path(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("from_path") or not b.get("to_path"):
        return err("Missing fields")
    try:
        workspace.rename_path(b["chat_id"], b["from_path"], b["to_path"])
        return ok()
    except FileNotFoundError as e: return err(str(e), 404)
    except ValueError as e: return err(str(e))
    except Exception as e: return err(str(e), 500)

@app.post("/workspace/file/delete")
async def delete_path(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("path"): return err("Missing fields")
    try:
        workspace.delete_path(b["chat_id"], b["path"])
        return ok()
    except FileNotFoundError as e: return err(str(e), 404)
    except Exception as e: return err(str(e), 500)

@app.get("/workspace/folder/zip")
async def zip_folder(chat_id: str, path: str):
    from fastapi.responses import Response as FastAPIResponse
    import urllib.parse
    try:
        data = workspace.zip_folder(chat_id, path)
        folder_name = path.rstrip("/").split("/")[-1] or "folder"
        filename = urllib.parse.quote(f"{folder_name}.zip")
        return FastAPIResponse(
            content=data,
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )
    except FileNotFoundError as e: return err(str(e), 404)
    except ValueError as e: return err(str(e))
    except Exception as e: return err(str(e), 500)


# ── Workspace — git ───────────────────────────────────────────────────────────

@app.get("/workspace/git/log")
def git_log(chat_id: str, path: str = None):
    try: return {"commits": workspace.git_log(chat_id, path)}
    except Exception as e: return err(str(e))

@app.get("/workspace/git/show")
def git_show(chat_id: str, hash: str, path: str):
    try: return {"content": workspace.git_show(chat_id, hash, path)}
    except FileNotFoundError as e: return err(str(e), 404)
    except Exception as e: return err(str(e))

@app.post("/workspace/git/commit")
async def git_commit(req: Request):
    b = await req.json()
    if not b.get("chat_id"): return err("Missing chat_id")
    try: return {"hash": workspace.git_commit(b["chat_id"], b.get("message","Vulcan: commit"), b.get("paths"))}
    except Exception as e: return err(str(e))

@app.post("/workspace/git/restore")
async def git_restore(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("hash"): return err("Missing fields")
    try: return ok(hash=workspace.git_restore(b["chat_id"], b["hash"]))
    except Exception as e: return err(str(e))


@app.post("/workspace/git/restore-file")
async def git_restore_file(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("hash") or not b.get("path"): return err("Missing fields")
    try: return workspace.git_restore_file(b["chat_id"], b["hash"], b["path"], actor="user")
    except FileNotFoundError as e: return err(str(e), 404)
    except Exception as e: return err(str(e))


@app.get("/workspace/git/changed")
def git_changed(chat_id: str, path: str):
    try: return {"changed": workspace.has_changed_since_last_commit(chat_id, path)}
    except Exception as e: return err(str(e))


# ── Workspace — snapshots ─────────────────────────────────────────────────────

@app.post("/workspace/snapshot")
async def save_snapshot(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("path"): return err("Missing fields")
    try: return {"snapshot_id": workspace.save_snapshot(b["chat_id"], b["path"])}
    except Exception as e: return err(str(e))

@app.get("/workspace/snapshots")
def list_snapshots(chat_id: str, path: str):
    try: return {"snapshots": workspace.list_snapshots(chat_id, path)}
    except Exception as e: return err(str(e))

@app.get("/workspace/snapshot/show")
def get_snapshot(chat_id: str, id: str, path: str):
    try: return {"content": workspace.get_snapshot_content(chat_id, id, path)}
    except FileNotFoundError as e: return err(str(e), 404)
    except Exception as e: return err(str(e))


# ── Workspace — management ────────────────────────────────────────────────────

@app.get("/workspace/list")
def list_workspaces():
    try: return {"workspaces": workspace.list_workspaces()}
    except Exception as e: return err(str(e))

@app.post("/workspace/delete")
async def delete_workspace(req: Request):
    b = await req.json()
    if not b.get("chat_id"): return err("Missing chat_id")
    try: workspace.delete_workspace(b["chat_id"]); return ok()
    except Exception as e: return err(str(e))


# ── Attachments ──────────────────────────────────────────────────────────────

@app.post("/workspace/attachment")
async def upload_attachment(
    chat_id: str = Form(...),
    file: UploadFile = File(...),
):
    if not chat_id: return err("Missing chat_id")
    data = await file.read()
    try:
        filename = workspace.save_attachment(chat_id, file.filename, data)
        return ok(filename=filename, path=f"/attachments/{filename}")
    except Exception as e: return err(str(e))


# ── Container ─────────────────────────────────────────────────────────────────

@app.get("/container/status")
async def container_status(chat_id: str):
    return docker.status(chat_id)

@app.post("/container/start")
async def container_start(req: Request):
    body = await req.json()
    chat_id = body.get("chat_id")
    if not chat_id: return err("Missing chat_id")
    started = await asyncio.to_thread(docker.start_container, chat_id)
    if started:
        container_lifecycle.record_activity(chat_id, "manual-start")
    return {"ok": started}

@app.post("/container/stop")
async def container_stop(req: Request):
    body = await req.json()
    chat_id = body.get("chat_id")
    if not chat_id: return err("Missing chat_id")
    return await asyncio.to_thread(
        container_lifecycle.stop_container,
        chat_id,
        reason="manual",
        force=bool(body.get("force", False)),
    )

@app.post("/container/reset")
async def container_reset(req: Request):
    body = await req.json()
    chat_id = body.get("chat_id")
    if not chat_id: return err("Missing chat_id")
    return {"ok": docker.reset_container(chat_id)}

@app.post("/container/nuke")
async def container_nuke(req: Request):
    body = await req.json()
    chat_id = body.get("chat_id")
    if not chat_id: return err("Missing chat_id")
    workspace.pre_nuke_commit(chat_id)
    return {"ok": docker.nuke_chat(chat_id)}

@app.get("/containers/running")
def containers_running():
    return {"chat_ids": docker.list_running_containers()}


# ── Panels ────────────────────────────────────────────────────────────────────

@app.post("/dashboard/create")
async def dashboard_create(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("name"): return err("Missing fields")
    try:
        workspace.dashboard_create(b["chat_id"], b["name"], b.get("html",""), b.get("css",""), b.get("js",""))
        return ok(name=b["name"])
    except (ValueError, FileExistsError) as e: return err(str(e))
    except Exception as e: return err(str(e), 500)

@app.post("/dashboard/update")
async def dashboard_update(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("name") or not b.get("part"): return err("Missing fields")
    try:
        workspace.dashboard_update(b["chat_id"], b["name"], b["part"], b.get("content",""))
        return ok(name=b["name"])
    except FileNotFoundError as e: return err(str(e), 404)
    except ValueError as e: return err(str(e))
    except Exception as e: return err(str(e), 500)

@app.get("/dashboard/inspect")
def dashboard_inspect(chat_id: str, name: str, part: str):
    try: return {"content": workspace.dashboard_inspect(chat_id, name, part)}
    except FileNotFoundError as e: return err(str(e), 404)
    except ValueError as e: return err(str(e))
    except Exception as e: return err(str(e), 500)

@app.get("/dashboards")
def dashboard_list(chat_id: str):
    try: return {"panels": workspace.dashboard_list(chat_id)}
    except Exception as e: return err(str(e))

@app.get("/dashboard")
def dashboard_get(chat_id: str, name: str):
    try: return {"html": workspace.dashboard_get_html(chat_id, name)}
    except FileNotFoundError as e: return err(str(e), 404)
    except Exception as e: return err(str(e), 500)

@app.delete("/dashboard")
async def dashboard_delete(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("name"): return err("Missing fields")
    try:
        workspace.dashboard_delete(b["chat_id"], b["name"])
        return ok()
    except FileNotFoundError as e: return err(str(e), 404)
    except Exception as e: return err(str(e), 500)


# ── Design reverse proxy ─────────────────────────────────────────────────────
# Design apps keep their provider-native URL in chat metadata. The Electron
# surface opens a stable Vulcan URL keyed by chat + Design id. An opaque HttpOnly
# routing ticket then lets root-absolute assets and HMR WebSockets stay on the
# same proxied origin without leaking the Vulcan session credential upstream.



def _design_by_id(chat_id: str, design_id: str) -> dict | None:
    chat = chats.load_chat_metadata(chat_id)
    if not isinstance(chat, dict):
        return None
    designs = chat.get("designs")
    if not isinstance(designs, list):
        legacy = chat.get("design") or chat.get("livePane")
        designs = [legacy] if isinstance(legacy, dict) else []
    return next((item for item in designs if isinstance(item, dict) and str(item.get("id")) == design_id), None)


def _strip_legacy_design_cookie(raw_cookie: str) -> str:
    # R12 and earlier could leave this cookie in a Design partition. It is no
    # longer used for routing, and it must never be forwarded to the app.
    parts = []
    for part in raw_cookie.split(";"):
        name = part.strip().split("=", 1)[0].strip()
        if name != "vulcan_design_route" and part.strip():
            parts.append(part.strip())
    return "; ".join(parts)

def _design_target(design: dict, path: str = "", *, root_absolute: bool = False, query_items=()) -> str:
    raw = str(design.get("url") or "")
    parsed = urlsplit(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Design URL must be HTTP or HTTPS")
    if root_absolute:
        target_path = "/" + path.lstrip("/")
        base_query = []
    elif path:
        base_path = parsed.path or "/"
        if not base_path.endswith("/"):
            base_path += "/"
        base = urlunsplit((parsed.scheme, parsed.netloc, base_path, "", ""))
        joined = urlsplit(urljoin(base, path))
        parsed = joined
        target_path = joined.path
        base_query = list(parse_qsl(joined.query, keep_blank_values=True))
    else:
        target_path = parsed.path or "/"
        base_query = list(parse_qsl(parsed.query, keep_blank_values=True))
    merged = base_query + [(k, v) for k, v in query_items if k not in ("vulcan_session", "vulcan_design_root")]
    return urlunsplit((parsed.scheme, parsed.netloc, target_path, urlencode(merged, doseq=True), ""))


async def _proxy_design_http(request: Request, design: dict, path: str = "", *, root_absolute: bool = False):
    import httpx
    target = _design_target(design, path, root_absolute=root_absolute,
                            query_items=request.query_params.multi_items())
    target_parts = urlsplit(target)
    excluded = {"host", "authorization", "connection", "keep-alive", "proxy-authenticate",
                "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}
    headers = {k: v for k, v in request.headers.items() if k.lower() not in excluded}
    if "cookie" in headers:
        clean_cookie = _strip_legacy_design_cookie(headers["cookie"])
        if clean_cookie:
            headers["cookie"] = clean_cookie
        else:
            headers.pop("cookie", None)
    upstream_origin = f"{target_parts.scheme}://{target_parts.netloc}"
    if "origin" in headers:
        headers["origin"] = upstream_origin
    if "referer" in headers:
        headers["referer"] = upstream_origin + "/"
    body = await request.body()
    client = await network.client()
    try:
        upstream = client.build_request(method=request.method, url=target, headers=headers, content=body,
                                        timeout=httpx.Timeout(30.0, read=None))
        resp = await client.send(upstream, stream=True)
        async def forward():
            try:
                async for chunk in resp.aiter_raw():
                    yield chunk
            finally:
                await resp.aclose()
        outgoing = {k: v for k, v in resp.headers.items()
                    if k.lower() not in excluded and k.lower() not in {"content-length", "set-cookie"}}
        location = resp.headers.get("location")
        if location:
            resolved = urlsplit(urljoin(target, location))
            if (resolved.scheme, resolved.netloc) == (target_parts.scheme, target_parts.netloc):
                outgoing["location"] = resolved.path + (("?" + resolved.query) if resolved.query else "")
        response = StreamingResponse(forward(), status_code=resp.status_code, headers=outgoing)
        for cookie in resp.headers.get_list("set-cookie"):
            response.raw_headers.append((b"set-cookie", cookie.encode("latin-1", "ignore")))
        return response
    except httpx.ConnectError:
        return err("Design target is not reachable — is the app running?", 502)
    except Exception as exc:
        return err(str(exc), 502)


def _design_screenshot_workspace_path(raw: str) -> str:
    requested = str(raw or "").strip().replace("\\", "/")
    if requested.startswith("/workspace/"):
        requested = requested.removeprefix("/workspace/")
    if not requested:
        requested = f"screenshots/design-{int(time.time() * 1000)}.png"
    parsed = PurePosixPath(requested)
    if parsed.is_absolute() or any(part in ("", ".", "..") for part in parsed.parts):
        raise ValueError(f"Invalid screenshot workspace path: {requested}")
    if parsed.suffix.lower() != ".png":
        raise ValueError("Design screenshots must use a .png workspace path")
    return str(parsed)


@app.post("/design-screenshot/{chat_id}/{design_id}")
async def design_screenshot_upload(request: Request, chat_id: str, design_id: str):
    # Screenshot pixels are intentionally kept out of the General WS and the
    # React renderer. Electron main captures the Design guest and uploads the
    # PNG directly here; only compact workspace metadata returns to the tool.
    design = await asyncio.to_thread(_design_by_id, chat_id, design_id)
    if design is None:
        return err("Design not found", 404)
    try:
        workspace_path = _design_screenshot_workspace_path(request.query_params.get("path", ""))
    except ValueError as exc:
        return err(str(exc), 400)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > 32 * 1024 * 1024:
                return err("Design screenshot exceeds 32 MiB limit", 413)
        except ValueError:
            pass
    image = await request.body()
    if len(image) > 32 * 1024 * 1024:
        return err("Design screenshot exceeds 32 MiB limit", 413)
    if len(image) < 8 or image[:8] != b"\x89PNG\r\n\x1a\n":
        return err("Design screenshot payload is not a PNG", 400)
    try:
        await asyncio.to_thread(workspace.write_file_bytes, chat_id, workspace_path, image)
    except Exception as exc:
        return err(str(exc), 400)
    return ok(
        saved_to=f"/workspace/{workspace_path}",
        workspace_path=workspace_path,
        mime_type="image/png",
        bytes=len(image),
    )


@app.api_route("/design/{chat_id}/{design_id}", methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"])
@app.api_route("/design/{chat_id}/{design_id}/{path:path}", methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"])
async def design_proxy(request: Request, chat_id: str, design_id: str, path: str = ""):
    design = await asyncio.to_thread(_design_by_id, chat_id, design_id)
    if design is None:
        return err("Design not found", 404)
    root_absolute = request.query_params.get("vulcan_design_root") == "1"
    return await _proxy_design_http(request, design, path, root_absolute=root_absolute)


async def _proxy_design_websocket(websocket: WebSocket, design: dict, path: str, *, root_absolute: bool = True):
    import websockets
    query = [(key, value) for key, value in websocket.query_params.multi_items() if key not in ("vulcan_session", "vulcan_design_root")]
    target_http = _design_target(design, path, root_absolute=root_absolute, query_items=query)
    parts = urlsplit(target_http)
    target = urlunsplit(("wss" if parts.scheme == "https" else "ws", parts.netloc, parts.path, parts.query, ""))
    cookie = websocket.headers.get("cookie", "")
    origin = f"{parts.scheme}://{parts.netloc}"
    extra_headers = {}
    if cookie:
        extra_headers["Cookie"] = cookie
    try:
        async with websockets.connect(target, origin=origin, additional_headers=extra_headers or None) as remote:
            await websocket.accept()
            async def browser_to_target():
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        break
                    if message.get("text") is not None:
                        await remote.send(message["text"])
                    elif message.get("bytes") is not None:
                        await remote.send(message["bytes"])
            async def target_to_browser():
                async for message in remote:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)
            tasks = {asyncio.create_task(browser_to_target()), asyncio.create_task(target_to_browser())}
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
    except Exception:
        try:
            await websocket.close(code=1011, reason="Design WebSocket target unavailable")
        except Exception:
            pass

# ── Container proxy ───────────────────────────────────────────────────────────
# Allows rendered HTML/JS to reach HTTP servers and WebSocket servers running
# inside the chat's Docker container, which is otherwise unreachable from the
# browser directly.
#
# HTTP:  GET/POST/etc  /proxy/{chat_id}/{port}/{path}
# WS:    ws://...      /proxy/ws/{chat_id}/{port}/{path}

@app.api_route("/proxy/{chat_id}/{port}/{path:path}", methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"])
async def http_proxy(chat_id: str, port: int, path: str, request: Request):
    import httpx
    if not 1 <= port <= 65535:
        return err("Service port must be between 1 and 65535")
    ip = docker.container_ip(chat_id)
    if not ip:
        return err(f"Container for chat {chat_id} is not running", 502)
    target = f"http://{ip}:{port}/{path}"
    forwarded_query = [(key, value) for key, value in request.query_params.multi_items() if key != "vulcan_session"]
    if forwarded_query:
        from urllib.parse import urlencode
        target += "?" + urlencode(forwarded_query)
    excluded = {"host", "authorization", "connection", "keep-alive", "proxy-authenticate",
                "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}
    headers = {k: v for k, v in request.headers.items() if k.lower() not in excluded}
    body = await request.body()
    client = await network.client()
    try:
        upstream = client.build_request(method=request.method, url=target, headers=headers, content=body,
                                        timeout=httpx.Timeout(30.0, read=None))
        resp = await client.send(upstream, stream=True)
        container_lifecycle.begin_service(chat_id, port)

        async def forward():
            try:
                async for chunk in resp.aiter_raw():
                    yield chunk
            finally:
                await resp.aclose()
                container_lifecycle.end_service(chat_id, port)

        outgoing = {key: value for key, value in resp.headers.items() if key.lower() not in excluded}
        return StreamingResponse(forward(), status_code=resp.status_code, headers=outgoing)
    except httpx.ConnectError:
        return err(f"Container port {port} not reachable — is the server running?", 502)
    except Exception as e:
        return err(str(e), 502)



@app.websocket("/proxy/ws/{chat_id}/{port}/{path:path}")
async def ws_proxy(websocket: WebSocket, chat_id: str, port: int, path: str):
    import websockets
    if not 1 <= port <= 65535:
        await websocket.close(code=1008, reason="Invalid service port")
        return
    if auth.server_requires_auth():
        if not auth.validate_session(websocket.query_params.get("vulcan_session", "")):
            await websocket.close(code=1008, reason="Authenticated Vulcan session required")
            return
    elif not _loopback_client(websocket.client.host if websocket.client else None):
        await websocket.close(code=1008, reason="Remote access requires a server password")
        return
    await websocket.accept()
    ip = docker.container_ip(chat_id)
    if not ip:
        await websocket.close(code=1011, reason="Container not running or has no IP")
        return
    query = [(key, value) for key, value in websocket.query_params.multi_items() if key not in ("vulcan_session", "vulcan_design_root")]
    target = f"ws://{ip}:{port}/{path}"
    if query:
        from urllib.parse import urlencode
        target += "?" + urlencode(query)
    service_active = False
    try:
        async with websockets.connect(target) as remote:
            container_lifecycle.begin_service(chat_id, port)
            service_active = True
            async def browser_to_container():
                try:
                    while True:
                        message = await websocket.receive()
                        if message.get("type") == "websocket.disconnect":
                            break
                        if message.get("text") is not None:
                            await remote.send(message["text"])
                        elif message.get("bytes") is not None:
                            await remote.send(message["bytes"])
                except (WebSocketDisconnect, Exception):
                    pass

            async def container_to_browser():
                try:
                    async for message in remote:
                        if isinstance(message, bytes):
                            await websocket.send_bytes(message)
                        else:
                            await websocket.send_text(message)
                except (WebSocketDisconnect, Exception):
                    pass

            tasks = {asyncio.create_task(browser_to_container()), asyncio.create_task(container_to_browser())}
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
    except Exception:
        pass
    finally:
        if service_active:
            container_lifecycle.end_service(chat_id, port)
        try:
            await websocket.close()
        except Exception:
            pass


class _DesignWebSocketRoutingMiddleware:
    """Route every WebSocket from a ticketed Design partition before Vulcan routes.

    This prevents app paths such as /ws/general from colliding with Vulcan's own
    WebSocket endpoints. Non-Design sessions pass through untouched.
    """
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "websocket":
            await self.inner(scope, receive, send)
            return
        websocket = WebSocket(scope, receive=receive, send=send)
        path = str(scope.get("path") or "/")
        explicit = re.match(r"^/design/([^/]+)/([^/]+)/(.*)$", path)
        if explicit:
            chat_id, design_id, design_path = explicit.groups()
            token = websocket.query_params.get("vulcan_session", "")
            if auth.server_requires_auth() and not auth.validate_session(token):
                await websocket.close(code=1008, reason="Authenticated Vulcan session required")
                return
            if not auth.server_requires_auth() and not _loopback_client(websocket.client.host if websocket.client else None):
                await websocket.close(code=1008, reason="Remote access requires a Vulcan server password")
                return
            design = await asyncio.to_thread(_design_by_id, chat_id, design_id)
            if design is None:
                await websocket.close(code=1008, reason="Design is no longer registered")
                return
            root_absolute = websocket.query_params.get("vulcan_design_root") == "1"
            await _proxy_design_websocket(websocket, design, design_path, root_absolute=root_absolute)
            return
        # Private-origin Design sockets always use the explicit /design/... namespace.
        # Everything else -- especially /ws/general -- bypasses Design routing entirely.
        await self.inner(scope, receive, send)


app.add_middleware(_DesignWebSocketRoutingMiddleware)
