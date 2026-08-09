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

Wait endpoint:
  POST /terminal/wait         { chat_id, seconds }     → { pid }

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
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from vulcan import config as cfg
from vulcan import docker, workspace, chats
from vulcan import terminal as term
from vulcan import auth
from vulcan import ws_terminal
from vulcan import ws_general

app = FastAPI(title="Vulcan")

# Log auth state at startup
async def _keep_global_running():
    """Keep the shared global environment alive for the lifetime of Vulcan."""
    while True:
        try:
            await asyncio.to_thread(docker.ensure_global)
        except Exception:
            import logging
            logging.getLogger("vulcan").exception("Failed to ensure global environment")
        await asyncio.sleep(5)


@app.on_event("startup")
async def _startup():
    if auth.server_requires_auth():
        import logging
        logging.getLogger("vulcan").info("Server password is set — authentication required")
    # Start immediately and keep it alive. Docker's unless-stopped restart policy
    # covers daemon/host restarts; this supervisor also recovers manual/process exits.
    asyncio.create_task(_keep_global_running())
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])


def ok(**kw):  return {"ok": True, **kw}
def err(msg, status=400): return JSONResponse({"error": msg}, status_code=status)


# ── Status ────────────────────────────────────────────────────────────────────

@app.get("/ping")
def ping(): return {"ok": True}

@app.get("/auth/status")
def auth_status():
    """Returns whether this server requires authentication. Always public."""
    return {"requires_auth": auth.server_requires_auth()}

@app.get("/status")
def status():
    config = cfg.load()
    return {"version": "0.1.0", "port": config.get("port", cfg.DEFAULT_PORT),
            "global_environment": docker.global_status()}


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
    pid = term.run_command(chat_id, cmd, timeout=timeout, background=background)
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
                "detached": wp.detached, "detach_reason": wp.detach_reason}
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
    if not chat_id: return err("Missing chat_id")
    pid = term.start_wait(chat_id, seconds)
    return {"pid": pid}


# ── Terminal WebSocket ────────────────────────────────────────────────────────

@app.websocket("/ws/terminal/{chat_id}/{kind}/{slot}")
async def terminal_ws(websocket: WebSocket, chat_id: str, kind: str, slot: int):
    """
    WebSocket per terminal slot. Replaces SSE stream + REST input/resize.
    kind: 'agent' | 'user'
    slot: 1-3
    """
    await ws_terminal.handle(websocket, chat_id, kind, slot)


@app.websocket("/ws/general")
async def general_ws(websocket: WebSocket):
    """
    General WebSocket — replaces REST API for all non-streaming operations.
    One connection per Electron session. Authenticated if server has a password.
    """
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
    timeout = int(b.get("timeout", 180))
    if not all([chat_id, slot, cmd]): return err("Missing fields")
    try:
        pid = term.run_command_in_slot(chat_id, kind, int(slot), cmd, timeout)
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
    try: return {"hash": workspace.git_commit(b["chat_id"], b.get("message","Vulcan: commit"))}
    except Exception as e: return err(str(e))

@app.post("/workspace/git/restore")
async def git_restore(req: Request):
    b = await req.json()
    if not b.get("chat_id") or not b.get("hash"): return err("Missing fields")
    try: return ok(hash=workspace.git_restore(b["chat_id"], b["hash"]))
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
    return {"ok": docker.start_container(chat_id)}

@app.post("/container/stop")
async def container_stop(req: Request):
    body = await req.json()
    chat_id = body.get("chat_id")
    if not chat_id: return err("Missing chat_id")
    return {"ok": docker.stop_container(chat_id)}

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
    ip = docker.container_ip(chat_id)
    if not ip:
        return err(f"Container for chat {chat_id} is not running or has no IP on the vulcan network", 502)
    target = f"http://{ip}:{port}/{path}"
    if request.query_params:
        target += "?" + str(request.query_params)
    headers = {k: v for k, v in request.headers.items() if k.lower() != "host"}
    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(
                method=request.method,
                url=target,
                headers=headers,
                content=body,
            )
        from fastapi.responses import Response as FastAPIResponse
        return FastAPIResponse(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )
    except httpx.ConnectError:
        return err(f"Container port {port} not reachable — is the server running?", 502)
    except Exception as e:
        return err(str(e), 502)



@app.websocket("/proxy/ws/{chat_id}/{port}/{path:path}")
async def ws_proxy(websocket: WebSocket, chat_id: str, port: int, path: str):
    import websockets
    await websocket.accept()
    ip = docker.container_ip(chat_id)
    if not ip:
        await websocket.close(code=1011, reason="Container not running or has no IP")
        return
    query = websocket.query_params
    target = f"ws://{ip}:{port}/{path}"
    if query:
        target += "?" + str(query)
    try:
        async with websockets.connect(target) as remote:
            async def browser_to_container():
                try:
                    while True:
                        data = await websocket.receive_bytes()
                        await remote.send(data)
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

            await asyncio.gather(browser_to_container(), container_to_browser())
    except Exception:
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
