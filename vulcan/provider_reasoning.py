"""Optional Chat Completions controls; response parsing is provider independent."""

from __future__ import annotations

import json
import re
import time
from typing import Any
from urllib.parse import urlsplit


# Short-lived, bounded, and isolated by endpoint/model/client. A gateway may
# route models differently, so one rejection must not disable another model.
_REJECTED: dict[tuple[str, ...], tuple[float, frozenset[str]]] = {}
_CACHE_SECONDS = 3600


def _key(provider: dict[str, Any]) -> tuple[str, ...]:
    return (
        str(provider.get("baseUrl") or provider.get("base_url") or "").rstrip("/"),
        str(provider.get("model") or ""),
        str(provider.get("networkPointOfView") or "server"),
        str(provider.get("clientId") or ""),
    )


def request_controls(provider: dict[str, Any]) -> dict[str, Any]:
    """Choose dialect by exact host, never by the user-defined provider label.

    Unknown/local endpoints and OpenAI use model defaults. In particular, the
    Responses API's reasoning object is not a Chat Completions parameter.
    """
    host = urlsplit(_key(provider)[0]).hostname
    model = str(provider.get("model") or "").lower()
    controls: dict[str, Any] = {}
    if host == "openrouter.ai":
        controls = {"reasoning": {"enabled": True}}
    elif host == "api.groq.com":
        if model.startswith("qwen/"):
            controls = {"reasoning_format": "parsed"}
        elif model.startswith("openai/gpt-oss-"):
            controls = {"include_reasoning": True}
    cached = _REJECTED.get(_key(provider))
    if cached and time.monotonic() - cached[0] < _CACHE_SECONDS:
        controls = {key: value for key, value in controls.items() if key not in cached[1]}
    return controls


def rejected_control(error: Exception, controls: dict[str, Any]) -> str | None:
    """Retry only an explicit unknown/unsupported optional request property.

    Both direct HTTP and client relay errors carry this status/body envelope.
    Authentication, rate limits, invalid values and transport failures propagate.
    """
    match = re.fullmatch(r"LLM error (400|422): (.*)", str(error), re.DOTALL)
    if not match:
        return None
    try:
        payload = json.loads(match[2])
    except (ValueError, TypeError):
        return None
    detail = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(detail, dict):
        return None
    message = str(detail.get("message") or "").lower()
    if not re.search(r"unsupported|not supported|unknown|unrecognized|not permitted", message):
        return None
    for field in controls:
        if detail.get("param") == field or re.search(
            r"(?:property|parameter|argument|field)\s*[:=]?\s*['\"`]?" + re.escape(field) + r"\b", message
        ):
            return field
    return None


def remember_rejection(provider: dict[str, Any], field: str) -> None:
    key = _key(provider)
    now = time.monotonic()
    previous = _REJECTED.get(key)
    fields = previous[1] if previous and now - previous[0] < _CACHE_SECONDS else frozenset()
    if key not in _REJECTED and len(_REJECTED) >= 256:
        del _REJECTED[next(iter(_REJECTED))]
    _REJECTED[key] = (now, fields | {field})
