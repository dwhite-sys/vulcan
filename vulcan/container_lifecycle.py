"""Server-owned chat container activity, inspection, and idle shutdown."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from vulcan import agent_runtime, config as cfg, docker, terminal

logger = logging.getLogger("vulcan.containers")
_lock = threading.RLock()
_service_leases: dict[str, dict[int, int]] = defaultdict(dict)
_client_chat_leases: dict[str, str] = {}


def _state_path(chat_id: str) -> Path:
    if not isinstance(chat_id, str) or not chat_id.strip() or Path(chat_id).name != chat_id or chat_id in (".", ".."):
        raise ValueError("Container lifecycle requires a valid chat id")
    return cfg.CHATS_DIR / chat_id / "container-lifecycle.json"


def _read_state(chat_id: str) -> dict[str, Any]:
    try:
        value = json.loads(_state_path(chat_id).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _write_state(chat_id: str, state: dict[str, Any]) -> None:
    path = _state_path(chat_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def policy() -> dict[str, Any]:
    """Return effective persisted settings without exposing unrelated server config."""
    values = cfg.load().get("containers", {})
    defaults = cfg.DEFAULT_CONFIG["containers"]
    return {name: values.get(name, default) for name, default in defaults.items()}


def update_policy(values: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(values, dict):
        raise ValueError("Container lifecycle settings must be an object")
    defaults = cfg.DEFAULT_CONFIG["containers"]
    unknown = set(values) - set(defaults)
    if unknown:
        raise ValueError(f"Unknown container lifecycle setting: {sorted(unknown)[0]}")

    for key in ("idle_timeout_seconds", "reap_interval_seconds"):
        if key not in values:
            continue
        value = values[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{key} must be a non-negative integer")
        if key == "reap_interval_seconds" and value < 5:
            raise ValueError("reap_interval_seconds must be at least 5")

    for key in ("protect_active_runs", "protect_open_terminals", "protect_dashboard_services"):
        if key in values and not isinstance(values[key], bool):
            raise ValueError(f"{key} must be true or false")

    with _lock:
        config = cfg.load()
        config["containers"] = {**config.get("containers", {}), **values}
        cfg.save(config)
    return policy()


def set_client_chat(client_id: str, chat_id: str | None) -> None:
    """Track which persisted chat a connected client currently has open.

    Client presence is an idle-reaping lease, not a container start request. A
    manually stopped container stays stopped; reopening/terminal input can start
    it through the normal container path.
    """
    if not isinstance(client_id, str) or not client_id.strip():
        raise ValueError("Client presence requires a client id")
    normalized = chat_id.strip() if isinstance(chat_id, str) else ""
    if normalized:
        _state_path(normalized)  # validate the chat id without mutating state
    with _lock:
        previous = _client_chat_leases.get(client_id)
        if normalized:
            _client_chat_leases[client_id] = normalized
        else:
            _client_chat_leases.pop(client_id, None)
    if normalized and normalized != previous:
        record_activity(normalized, "chat-open")


def _open_client_count(chat_id: str) -> int:
    with _lock:
        return sum(1 for leased_chat in _client_chat_leases.values() if leased_chat == chat_id)


def record_activity(chat_id: str, source: str, *, at: float | None = None) -> dict[str, Any]:
    if not isinstance(chat_id, str) or not chat_id.strip():
        raise ValueError("Container activity requires a chat id")
    instant = time.time() if at is None else float(at)
    with _lock:
        state = _read_state(chat_id)
        state["last_activity"] = instant
        state["last_activity_source"] = source
        _write_state(chat_id, state)
    return state


def begin_service(chat_id: str, port: int) -> None:
    with _lock:
        ports = _service_leases[chat_id]
        ports[port] = ports.get(port, 0) + 1
    record_activity(chat_id, "dashboard-service")


def end_service(chat_id: str, port: int) -> None:
    with _lock:
        ports = _service_leases.get(chat_id)
        if ports:
            count = ports.get(port, 0) - 1
            if count > 0:
                ports[port] = count
            else:
                ports.pop(port, None)
            if not ports:
                _service_leases.pop(chat_id, None)
    record_activity(chat_id, "dashboard-service-ended")


def _active_run(chat_id: str) -> bool:
    run = agent_runtime.MANAGER.runs.get(chat_id)
    return bool(run and run.status == "running" and run.task and not run.task.done())


def inspect_container(chat_id: str, *, now: float | None = None) -> dict[str, Any]:
    instant = time.time() if now is None else float(now)
    configuration = policy()
    details = docker.status(chat_id)
    state = _read_state(chat_id)
    last_activity = state.get("last_activity")
    if not isinstance(last_activity, (float, int)):
        last_activity = instant
        if details.get("container_running"):
            state = record_activity(chat_id, "discovered", at=instant)

    reasons: list[str] = []
    slots: list[dict[str, Any]] = []
    ports: list[int] = []
    listening = False
    if details.get("container_running"):
        if configuration["protect_active_runs"] and _active_run(chat_id):
            reasons.append("active-agent-run")

        open_client_count = _open_client_count(chat_id)
        if open_client_count:
            reasons.append("open-chat")

        slots = [slot for slot in terminal.list_slots(chat_id) if not slot.get("finished")]
        if configuration["protect_open_terminals"] and slots:
            reasons.append("open-terminal")

        with _lock:
            ports = sorted(_service_leases.get(chat_id, {}))
        if configuration["protect_dashboard_services"]:
            listening = bool(ports) or docker.container_has_listening_service(chat_id)
            if listening:
                reasons.append("dashboard-service")

        if reasons and instant - float(last_activity) >= configuration["reap_interval_seconds"]:
            state = record_activity(chat_id, reasons[0], at=instant)
            last_activity = instant

    timeout = configuration["idle_timeout_seconds"]
    idle_seconds = max(0.0, instant - float(last_activity))
    return {
        "chat_id": chat_id,
        **details,
        "last_activity": float(last_activity),
        "last_activity_source": state.get("last_activity_source", "discovered"),
        "idle_seconds": idle_seconds,
        "idle_timeout_seconds": timeout,
        "idle_shutdown_enabled": timeout > 0,
        "protected": bool(reasons),
        "protection_reasons": reasons,
        "open_terminal_count": len(slots),
        "open_client_count": _open_client_count(chat_id),
        "active_service_ports": ports,
        "has_listening_service": listening,
        "last_stopped_at": state.get("last_stopped_at"),
        "last_stop_reason": state.get("last_stop_reason"),
    }


def inspect_running_containers(*, now: float | None = None) -> list[dict[str, Any]]:
    return [inspect_container(chat_id, now=now) for chat_id in docker.list_running_containers()]


def stop_container(chat_id: str, *, reason: str = "manual", force: bool = False) -> dict[str, Any]:
    details = inspect_container(chat_id)
    if not details["container_running"]:
        return {"ok": True, "chat_id": chat_id, "stopped": False, "reason": "already-stopped"}
    if details["protected"] and not force:
        # An open chat is an idle-shutdown lease, not a veto over an explicit
        # manual stop. Active work/services retain the existing manual safeguard.
        blocking_reasons = list(details["protection_reasons"])
        if reason != "idle-timeout":
            blocking_reasons = [item for item in blocking_reasons if item != "open-chat"]
        if blocking_reasons:
            return {
                "ok": False,
                "chat_id": chat_id,
                "error": "Container is protected by active work or a dashboard service",
                "protection_reasons": blocking_reasons,
            }

    if force:
        agent_runtime.MANAGER.cancel(chat_id)
    terminal.close_chat_slots(chat_id, reason="container-stopped")
    stopped = docker.stop_container(chat_id)
    if not stopped:
        return {"ok": False, "chat_id": chat_id, "error": "Docker could not stop the container"}

    instant = time.time()
    with _lock:
        state = _read_state(chat_id)
        state["last_stopped_at"] = instant
        state["last_stop_reason"] = reason
        _write_state(chat_id, state)
    logger.info("Stopped chat container %s (%s)", chat_id, reason)
    return {"ok": True, "chat_id": chat_id, "stopped": True, "reason": reason}


def reap_idle_containers(*, now: float | None = None) -> dict[str, Any]:
    instant = time.time() if now is None else float(now)
    configuration = policy()
    if configuration["idle_timeout_seconds"] <= 0:
        return {"enabled": False, "inspected": 0, "stopped": [], "protected": []}

    stopped: list[str] = []
    protected: list[str] = []
    containers = inspect_running_containers(now=instant)
    for details in containers:
        chat_id = details["chat_id"]
        if details["protected"]:
            protected.append(chat_id)
            continue
        if details["idle_seconds"] < configuration["idle_timeout_seconds"]:
            continue
        result = stop_container(chat_id, reason="idle-timeout")
        if result["ok"] and result.get("stopped"):
            stopped.append(chat_id)
        elif result.get("protection_reasons"):
            protected.append(chat_id)
    return {
        "enabled": True,
        "inspected": len(containers),
        "stopped": stopped,
        "protected": protected,
    }
