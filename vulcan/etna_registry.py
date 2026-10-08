"""Ephemeral client HTTP relay registry.

Provider and Etna endpoint definitions are owned by each Vulcan client and are
never persisted here.  The server only tracks currently authenticated client
sessions long enough to relay CLIENT-POV HTTP work for server-owned agent runs.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections import deque
from typing import Any

logger = logging.getLogger("vulcan.etna_registry")

# Client-POV provider relay flow control. The client may have at most
# RELAY_WINDOW_BYTES of stream data outstanding (sent but not yet consumed by
# the server-side run); consumption returns credit. The chain is therefore
#   run slow -> no credit -> browser relay waits -> fetch reader waits
# which is real backpressure all the way to the provider connection.
RELAY_WINDOW_BYTES = 256 * 1024
# Clients that predate credits cannot be slowed; bound what they can queue.
RELAY_HARD_CAP_BYTES = 16 * 1024 * 1024
_CREDIT_FRACTION = 4


def _post(session: Any, message: dict[str, Any]) -> None:
    """Non-blocking control push to a client session (never parks a task on
    lane-aware sessions)."""
    post = getattr(session, "post", None)
    if post is not None:
        post(message)
    else:
        asyncio.create_task(session.send(message))


class RelayStream:
    """Byte-accounted relay backlog for one client HTTP stream."""

    def __init__(self, session: Any, relay_id: str, window: int = RELAY_WINDOW_BYTES) -> None:
        self.session = session
        self.relay_id = relay_id
        self.window = window
        self._items: deque[tuple[dict[str, Any], int]] = deque()
        self._event = asyncio.Event()
        self.bytes = 0
        self.peak_bytes = 0
        self.consumed_unacked = 0
        self.overflowed = False

    def put(self, payload: dict[str, Any]) -> None:
        if self.overflowed:
            return
        size = 0
        if payload.get("event") == "chunk":
            declared = payload.get("n")
            size = declared if isinstance(declared, int) and declared >= 0 else len(str(payload.get("data") or ""))
        if self.bytes + size > RELAY_HARD_CAP_BYTES:
            # Refuse to become an unbounded buffer. The stream fails loudly;
            # the run surfaces the error instead of eating server memory.
            self.overflowed = True
            self._items.clear()
            self.bytes = 0
            self._items.append(({"event": "error", "error": "Client relay backlog exceeded"}, 0))
            self._event.set()
            return
        self._items.append((payload, size))
        self.bytes += size
        self.peak_bytes = max(self.peak_bytes, self.bytes)
        self._event.set()

    async def get(self, timeout: float) -> dict[str, Any]:
        while not self._items:
            self._event.clear()
            await asyncio.wait_for(self._event.wait(), timeout=timeout)
        payload, size = self._items.popleft()
        self.bytes -= size
        if size:
            self.consumed_unacked += size
        # Batch credits, but always return them once the backlog is drained:
        # a sender blocked on a full window must never wait on a remainder
        # smaller than the batch threshold (that would deadlock both ends).
        if self.consumed_unacked and (
            not self._items or self.consumed_unacked >= max(1, self.window // _CREDIT_FRACTION)
        ):
            self.grant()
        return payload

    def grant(self) -> None:
        if not self.consumed_unacked:
            return
        credit, self.consumed_unacked = self.consumed_unacked, 0
        try:
            _post(self.session, {"type": "push/client-http-credit", "payload": {
                "relay_id": self.relay_id, "bytes": credit,
            }})
        except Exception:
            logger.debug("Could not grant relay credit", exc_info=True)


CLIENT_SESSIONS: dict[str, Any] = {}
RELAY_FUTURES: dict[str, asyncio.Future] = {}
HTTP_STREAMS: dict[str, RelayStream] = {}
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
            stream = HTTP_STREAMS.get(relay_id)
            if stream is not None:
                stream.put({"event": "error", "error": "Client disconnected during HTTP request"})
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
    idle_timeout: float | None = None,
):
    """Yield text chunks from an HTTP response executed by one authenticated client."""
    session = CLIENT_SESSIONS.get(client_id)
    if session is None:
        raise RuntimeError("The client selected for this endpoint is not connected")
    relay_id = uuid.uuid4().hex
    stream = RelayStream(session, relay_id)
    HTTP_STREAMS[relay_id] = stream
    RELAY_CLIENTS[relay_id] = client_id
    completed = False
    response_timeout = idle_timeout if idle_timeout is not None else timeout + 2
    try:
        await session.send({"type": "push/client-http-request", "payload": {
            "relay_id": relay_id, "url": url, "method": method,
            "headers": headers or {}, "body": body, "stream": True,
            "timeout_ms": int(timeout * 1000),
            # Credit-based flow control (clients without it ignore this).
            "flow": {"window_bytes": stream.window},
        }})
        while True:
            event = await stream.get(response_timeout)
            kind = event.get("event")
            if kind == "headers":
                status = int(event.get("status", 0))
                if status >= 400:
                    # The client follows with body chunks and done; collect a compact error.
                    chunks = []
                    while True:
                        item = await stream.get(response_timeout)
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
    stream = HTTP_STREAMS.get(relay_id)
    if stream is not None:
        stream.put(payload)
        return True
    future = RELAY_FUTURES.get(relay_id)
    if future is not None and not future.done():
        future.set_result(payload)
        return True
    return False


def relay_metrics() -> dict[str, Any]:
    return {
        "streams": len(HTTP_STREAMS),
        "backlog_bytes": sum(stream.bytes for stream in HTTP_STREAMS.values()),
        "peak_bytes": max((stream.peak_bytes for stream in HTTP_STREAMS.values()), default=0),
        "pending_requests": len(RELAY_FUTURES),
    }
