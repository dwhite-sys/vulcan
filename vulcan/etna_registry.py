"""Ephemeral client HTTP relay registry.

Provider and Etna endpoint definitions are owned by each Vulcan client and are
never persisted here.  The server only tracks currently authenticated client
sessions long enough to relay CLIENT-POV HTTP work for server-owned agent runs.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Any

CLIENT_SESSIONS: dict[str, Any] = {}
RELAY_FUTURES: dict[str, asyncio.Future] = {}
HTTP_STREAMS: dict[str, asyncio.Queue] = {}
RELAY_CLIENTS: dict[str, str] = {}
CLIENT_STATES: dict[str, dict[str, Any]] = {}


def register_client(client_id: str, session: Any) -> None:
    CLIENT_SESSIONS[client_id] = session


def unregister_client(client_id: str | None, session: Any) -> None:
    if client_id and CLIENT_SESSIONS.get(client_id) is session:
        CLIENT_SESSIONS.pop(client_id, None)
        CLIENT_STATES.pop(client_id, None)
        # Fail in-flight relays immediately rather than waiting for HTTP timeouts.
        for relay_id, owner in list(RELAY_CLIENTS.items()):
            if owner != client_id:
                continue
            queue = HTTP_STREAMS.get(relay_id)
            if queue is not None:
                queue.put_nowait({"event": "error", "error": "Client disconnected during HTTP request"})
            future = RELAY_FUTURES.get(relay_id)
            if future is not None and not future.done():
                future.set_result({"error": "Client disconnected during HTTP request"})


def set_client_state(client_id: str, key: str, value: Any) -> None:
    if not client_id:
        return
    CLIENT_STATES.setdefault(client_id, {})[key] = value


def get_client_state(client_id: str, key: str, default: Any = None) -> Any:
    return CLIENT_STATES.get(client_id, {}).get(key, default)


async def relay_json(client_id: str, base_url: str, path: str, method: str = "GET", body: Any = None, timeout: float = 30.0) -> Any:
    """Compatibility JSON helper over the generic abortable HTTP relay.

    Older builds had a second Etna-specific request/response transport without
    cancellation propagation. Keep the public helper but route it through the one
    generic relay so timeouts/disconnects abort the browser fetch consistently.
    """
    url = base_url.rstrip("/") + (path if path.startswith("/") else "/" + path)
    result = await relay_http(
        client_id, url, method, headers={"Content-Type": "application/json"},
        body=body, timeout=timeout,
    )
    status = int(result.get("status", 0))
    text = str(result.get("text") or "")
    if status >= 400:
        raise RuntimeError(f"Etna HTTP {status}: {text}")
    if not text:
        return {}
    try:
        return __import__("json").loads(text)
    except Exception:
        return {"result": text}


def resolve_relay(relay_id: str, payload: dict[str, Any]) -> bool:
    future = RELAY_FUTURES.get(relay_id)
    if not future or future.done():
        return False
    future.set_result(payload)
    return True


async def relay_client_action(
    client_id: str,
    event: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: float = 15.0,
) -> Any:
    """Ask one authenticated Vulcan client to perform a typed non-HTTP action."""
    session = CLIENT_SESSIONS.get(client_id)
    if session is None:
        raise RuntimeError("The client that owns this live surface is not connected")
    relay_id = uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()
    RELAY_FUTURES[relay_id] = future
    RELAY_CLIENTS[relay_id] = client_id
    try:
        await session.send({"type": f"push/{event}", "payload": {"relay_id": relay_id, **(payload or {})}})
        result = await asyncio.wait_for(future, timeout=timeout)
        if isinstance(result, dict) and result.get("error"):
            raise RuntimeError(str(result["error"]))
        return result.get("data") if isinstance(result, dict) else result
    finally:
        RELAY_FUTURES.pop(relay_id, None)
        RELAY_CLIENTS.pop(relay_id, None)



async def relay_http(
    client_id: str,
    url: str,
    method: str = "GET",
    *,
    headers: dict[str, str] | None = None,
    body: Any = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Perform a buffered HTTP request from one authenticated Vulcan client."""
    session = CLIENT_SESSIONS.get(client_id)
    if session is None:
        raise RuntimeError("The client selected for this endpoint is not connected")
    relay_id = uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()
    RELAY_FUTURES[relay_id] = future
    RELAY_CLIENTS[relay_id] = client_id
    try:
        await session.send({"type": "push/client-http-request", "payload": {
            "relay_id": relay_id, "url": url, "method": method,
            "headers": headers or {}, "body": body, "stream": False,
            "timeout_ms": int(timeout * 1000),
        }})
        result = await asyncio.wait_for(future, timeout=timeout + 2)
        if result.get("error"):
            raise RuntimeError(str(result["error"]))
        return result
    except (asyncio.CancelledError, asyncio.TimeoutError):
        try:
            await session.send({"type": "push/client-http-cancel", "payload": {"relay_id": relay_id}})
        except Exception:
            pass
        raise
    finally:
        RELAY_FUTURES.pop(relay_id, None)
        RELAY_CLIENTS.pop(relay_id, None)


async def relay_http_stream(
    client_id: str,
    url: str,
    method: str = "POST",
    *,
    headers: dict[str, str] | None = None,
    body: Any = None,
    timeout: float = 30.0,
):
    """Yield text chunks from an HTTP response executed by one authenticated client."""
    session = CLIENT_SESSIONS.get(client_id)
    if session is None:
        raise RuntimeError("The client selected for this endpoint is not connected")
    relay_id = uuid.uuid4().hex
    queue: asyncio.Queue = asyncio.Queue()
    HTTP_STREAMS[relay_id] = queue
    RELAY_CLIENTS[relay_id] = client_id
    completed = False
    try:
        await session.send({"type": "push/client-http-request", "payload": {
            "relay_id": relay_id, "url": url, "method": method,
            "headers": headers or {}, "body": body, "stream": True,
            "timeout_ms": int(timeout * 1000),
        }})
        while True:
            event = await asyncio.wait_for(queue.get(), timeout=timeout + 2)
            kind = event.get("event")
            if kind == "headers":
                status = int(event.get("status", 0))
                if status >= 400:
                    # The client follows with body chunks and done; collect a compact error.
                    chunks = []
                    while True:
                        item = await asyncio.wait_for(queue.get(), timeout=timeout + 2)
                        if item.get("event") == "chunk":
                            chunks.append(str(item.get("data") or ""))
                        elif item.get("event") == "done":
                            break
                        elif item.get("event") == "error":
                            raise RuntimeError(str(item.get("error") or "Client HTTP request failed"))
                    raise RuntimeError(f"LLM error {status}: {''.join(chunks)}")
            elif kind == "chunk":
                yield str(event.get("data") or "")
            elif kind == "done":
                completed = True
                return
            elif kind == "error":
                raise RuntimeError(str(event.get("error") or "Client HTTP request failed"))
    except (asyncio.CancelledError, asyncio.TimeoutError):
        try:
            await session.send({"type": "push/client-http-cancel", "payload": {"relay_id": relay_id}})
        except Exception:
            pass
        raise
    finally:
        # A consumer may stop as soon as it sees the provider's SSE terminal
        # marker, before the browser-side fetch reports HTTP EOF. Cancel that
        # request explicitly so it cannot linger for the full provider timeout.
        if not completed:
            try:
                await session.send({"type": "push/client-http-cancel", "payload": {"relay_id": relay_id}})
            except Exception:
                pass
        HTTP_STREAMS.pop(relay_id, None)
        RELAY_CLIENTS.pop(relay_id, None)


def resolve_http_event(relay_id: str, payload: dict[str, Any]) -> bool:
    queue = HTTP_STREAMS.get(relay_id)
    if queue is not None:
        queue.put_nowait(payload)
        return True
    future = RELAY_FUTURES.get(relay_id)
    if future is not None and not future.done():
        future.set_result(payload)
        return True
    return False
