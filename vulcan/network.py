"""Shared outbound HTTP transport for Vulcan.

Keep connection pools warm across provider/model/proxy calls so proxied traffic pays
as little setup cost as possible.  Retries are deliberately conservative: only
idempotent requests are retried automatically, and streaming/inference callers can
opt into connect-only retries before any response body has started.
"""
from __future__ import annotations

import asyncio
import random
import weakref
from typing import Any, Iterable

import httpx

_RETRY_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
_CLIENTS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]" = weakref.WeakKeyDictionary()
_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = weakref.WeakKeyDictionary()


def _default_timeout() -> httpx.Timeout:
    return httpx.Timeout(30.0, connect=10.0, pool=5.0)


async def client() -> httpx.AsyncClient:
    loop = asyncio.get_running_loop()
    existing = _CLIENTS.get(loop)
    if existing is not None and not existing.is_closed:
        return existing
    lock = _LOCKS.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _LOCKS[loop] = lock
    async with lock:
        existing = _CLIENTS.get(loop)
        if existing is not None and not existing.is_closed:
            return existing
        created = httpx.AsyncClient(
            timeout=_default_timeout(),
            limits=httpx.Limits(
                max_connections=100,
                max_keepalive_connections=32,
                keepalive_expiry=90.0,
            ),
            follow_redirects=False,
        )
        _CLIENTS[loop] = created
        return created


async def close_current_client() -> None:
    loop = asyncio.get_running_loop()
    current = _CLIENTS.pop(loop, None)
    _LOCKS.pop(loop, None)
    if current is not None and not current.is_closed:
        await current.aclose()


async def request(
    method: str,
    url: str,
    *,
    retries: int = 1,
    retry_statuses: Iterable[int] = _RETRY_STATUSES,
    retry_non_idempotent_connect: bool = False,
    **kwargs: Any,
) -> httpx.Response:
    """Issue a buffered request using the shared pool.

    Idempotent requests retry transient connection failures and selected HTTP
    statuses.  Non-idempotent requests are never status-retried; callers may opt
    into a connect-only retry, which is safe only when no response/request body
    could have been accepted upstream yet.
    """
    normalized = method.upper()
    can_retry_status = normalized in _IDEMPOTENT_METHODS
    can_retry_connect = can_retry_status or retry_non_idempotent_connect
    statuses = set(retry_statuses)
    attempts = max(1, int(retries) + 1)
    last_error: Exception | None = None

    for attempt in range(attempts):
        try:
            response = await (await client()).request(normalized, url, **kwargs)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            last_error = exc
            if not can_retry_connect or attempt + 1 >= attempts:
                raise
        else:
            if not can_retry_status or response.status_code not in statuses or attempt + 1 >= attempts:
                return response
            await response.aclose()

        # Tiny bounded jitter avoids a reconnect herd without making local
        # providers feel remote.  First retry lands in roughly 75-125 ms.
        await asyncio.sleep(min(0.5, 0.1 * (2 ** attempt)) * (0.75 + random.random() * 0.5))

    assert last_error is not None
    raise last_error
