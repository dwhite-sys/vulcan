"""
vulcan/ws_terminal.py — WebSocket handler for terminal slots

One WebSocket connection per terminal slot. Replaces:
  - GET  /terminal/slot/stream  (SSE)
  - POST /terminal/slot/input
  - POST /terminal/slot/resize
  - POST /terminal/slot/open
  - POST /terminal/slot/close
  - GET  /terminal/slot/scrollback
  - POST /terminal/slot/scrollback

Message protocol
────────────────
Client → Server:
  { "type": "open", "cols": N, "rows": N }
    Open/attach at authoritative client geometry. Server resizes first, then sends scrollback.

  { "type": "input", "text": "..." }
    Send raw input to the PTY. Both user and agent terminals accept direct user input.

  { "type": "resize", "cols": N, "rows": N }
    Resize the PTY window.

  { "type": "close" }
    Close the slot and disconnect.

Server → Client:
  { "type": "scrollback", "data": "..." }
    Saved scrollback string, sent once on connect before live output.

  { "type": "chunk", "data": "..." }
    Live PTY output chunk.

  { "type": "status", "connected": bool, "reason": "..." }
    Slot connection state change.

  { "type": "closed", "reason": "..." }
    Slot has been closed (inactivity, explicit close, container down).

  { "type": "error", "message": "..." }
    An error occurred.

Attribution
───────────
Both agent and user slots forward direct frontend input to the PTY.
This input is transported inside the encrypted terminal WebSocket and is not
placed in chat history or tool arguments.
"""

import asyncio
import json
import logging

from fastapi import WebSocket, WebSocketDisconnect

from vulcan import terminal as term
from vulcan import docker
from vulcan import auth
from vulcan import container_lifecycle
from vulcan.secure_ws import SecureWebSocketSession

logger = logging.getLogger("vulcan.ws_terminal")


async def handle(ws: WebSocket, chat_id: str, kind: str, slot: int):
    """
    Main WebSocket handler for a terminal slot.
    Called from the @app.websocket route in server.py.
    """
    secure_ws = await SecureWebSocketSession.accept(ws)

    slot_opened_here = False  # True if we opened the slot in this connection

    async def send(msg: dict):
        try:
            await secure_ws.send_json(msg)
        except Exception:
            pass

    try:
        # ── Wait for 'open' message ───────────────────────────────────────────
        msg = await asyncio.wait_for(secure_ws.receive_json(), timeout=10.0)
        if msg.get("type") != "open":
            await send({"type": "error", "message": "First message must be {type: 'open'}"})
            await ws.close()
            return

        if auth.server_requires_auth() and not auth.validate_session(str(msg.get("session_token") or "")):
            # This is recoverable protocol state, not a terminal/application
            # failure.  The client reconfirms through its authenticated General
            # WS, obtains a fresh subordinate capability, and retries this open.
            await send({
                "type": "error",
                "code": "auth_stale",
                "message": "Authenticated Vulcan session required",
            })
            await ws.close(code=1008)
            return

        # ── Establish authoritative geometry before any snapshot/output ────────
        cols = max(1, int(msg.get("cols", 80)))
        rows = max(1, int(msg.get("rows", 24)))
        key = term._slot_key(chat_id, kind, slot)
        before = term.agent_slot_state(chat_id, kind, slot) if kind == "agent" else term.slot_state(chat_id, kind, slot)
        try:
            # Viewer attachment is demand for this logical slot, but PTY ownership stays
            # in TerminalManager-style ensure_live_slot(). It always enters the same
            # chat/container workspace and serializes with agent recovery/explicit close.
            ts = await asyncio.to_thread(
                term.ensure_live_slot, chat_id, kind, slot, cols=cols, rows=rows, create=True
            )
            if ts is None:
                raise RuntimeError(f"Could not open terminal {slot}")
            slot_opened_here = before is None
        except (ValueError, RuntimeError) as e:
            await send({"type": "error", "message": str(e)})
            await ws.close()
            return

        # The server is the sole transcript authority. Send one coherent snapshot:
        # durable history from prior PTY sessions + the current PTY session exactly once.
        current_chunks = list(ts.output) if ts is not None else []
        sent_chunks = len(current_chunks)
        snapshot = (term.get_slot_scrollback(chat_id, kind, slot) or "") + "".join(current_chunks)
        if snapshot:
            await send({"type": "scrollback", "data": snapshot})

        await send({"type": "status", "connected": True})

        # ── Stream PTY output ─────────────────────────────────────────────────

        async def stream_output():
            nonlocal sent_chunks, ts
            generation = ts.generation
            while True:
                current = term._slots.get(key)
                if current is not None and current.generation != generation and not current.finished:
                    # Another lifecycle actor revived the logical slot. Rebind the viewer
                    # to the new physical incarnation rather than streaming a retired PTY.
                    ts = current
                    generation = current.generation
                    sent_chunks = 0
                    await send({"type": "status", "connected": True, "resumed": True})
                if ts is None:
                    break
                new_chunks = ts.output[sent_chunks:]
                for chunk in new_chunks:
                    await send({"type": "chunk", "data": chunk})
                sent_chunks += len(new_chunks)
                if ts.finished:
                    revived = await asyncio.to_thread(term.ensure_live_slot, chat_id, kind, slot)
                    if revived is not None and not revived.finished:
                        ts = revived
                        generation = revived.generation
                        sent_chunks = 0
                        await send({"type": "status", "connected": True, "resumed": True})
                        continue
                    await send({"type": "closed", "reason": ts.close_reason or "process_exit"})
                    try:
                        await ws.close()
                    except Exception:
                        pass
                    break
                await asyncio.sleep(0.02)

        stream_task = asyncio.create_task(stream_output())

        # ── Receive client messages ───────────────────────────────────────────
        try:
            while True:
                msg = await secure_ws.receive_json()
                mtype = msg.get("type")

                if mtype == "input":
                    if term.send_slot_input(chat_id, kind, slot, msg.get("text", "")):
                        container_lifecycle.record_activity(chat_id, "terminal-input")

                elif mtype == "resize":
                    cols = int(msg.get("cols", 80))
                    rows = int(msg.get("rows", 24))
                    term.resize_slot(chat_id, kind, slot, cols, rows)

                elif mtype == "close":
                    stream_task.cancel()
                    term.close_slot(chat_id, kind, slot)
                    await send({"type": "closed", "reason": "explicit"})
                    break

        except WebSocketDisconnect:
            stream_task.cancel()

        except Exception as e:
            logger.warning(f"Terminal WS error [{chat_id}/{kind}/{slot}]: {e}")
            stream_task.cancel()

        finally:
            try:
                stream_task.cancel()
                await stream_task
            except (asyncio.CancelledError, Exception):
                pass

    except asyncio.TimeoutError:
        await send({"type": "error", "message": "Timed out waiting for open message"})
        await ws.close()

    except WebSocketDisconnect:
        pass

    except Exception as e:
        logger.error(f"Terminal WS fatal [{chat_id}/{kind}/{slot}]: {e}")
        try:
            await ws.close()
        except Exception:
            pass
