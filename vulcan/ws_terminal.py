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
  { "type": "open" }
    Open the slot. Server responds with scrollback (if any) then starts streaming.

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

        # The Settings terminal addresses the persistent global environment via
        # the reserved chat id `global`. Ensure it exists before opening the PTY.
        if chat_id == docker.GLOBAL_CHAT_ID and not docker.ensure_global():
            await send({"type": "error", "message": "Global environment could not be started"})
            await ws.close()
            return

        # ── Restore scrollback ────────────────────────────────────────────────
        scrollback = term.get_slot_scrollback(chat_id, kind, slot)
        if scrollback:
            await send({"type": "scrollback", "data": scrollback})

        # ── Open slot if not already open ─────────────────────────────────────
        key = term._slot_key(chat_id, kind, slot)
        existing = term._slots.get(key)
        if not existing or existing.finished:
            try:
                opened_slot = term.open_slot(chat_id, kind)
                if opened_slot != slot:
                    # Shouldn't happen if caller passes correct slot, but handle it
                    await send({"type": "error", "message": f"Expected slot {slot}, got {opened_slot}"})
                    await ws.close()
                    return
                slot_opened_here = True
            except ValueError as e:
                await send({"type": "error", "message": str(e)})
                await ws.close()
                return

        await send({"type": "status", "connected": True})

        # ── Stream PTY output ─────────────────────────────────────────────────
        ts = term._slots.get(key)
        sent_chunks = 0

        async def stream_output():
            nonlocal sent_chunks
            while True:
                if ts is None:
                    break
                new_chunks = ts.output[sent_chunks:]
                for chunk in new_chunks:
                    await send({"type": "chunk", "data": chunk})
                sent_chunks += len(new_chunks)
                if ts.finished:
                    # The underlying docker-exec PTY ended (for example because
                    # vulcan-global restarted). Tell the renderer and close the
                    # socket so it cannot remain attached to a dead slot.
                    _save_scrollback_sync(chat_id, kind, slot, ts)
                    await send({"type": "closed", "reason": "process_exit"})
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
                    term.send_slot_input(chat_id, kind, slot, msg.get("text", ""))

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
            # Save scrollback on disconnect
            if ts:
                _save_scrollback_sync(chat_id, kind, slot, ts)

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


def _save_scrollback_sync(chat_id: str, kind: str, slot: int, ts):
    """Save scrollback from a slot's output buffer."""
    try:
        scrollback = "".join(ts.output)
        term.save_slot_scrollback(chat_id, kind, slot, scrollback)
    except Exception:
        pass
