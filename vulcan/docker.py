"""
vulcan/docker.py — Docker abstraction layer

Per-chat container model:
  - One container per chat, named vulcan-chat-<uuid>
  - All containers share the `vulcan` user-defined Docker network
  - Docker's embedded DNS remains first in the lookup path
  - Queries Docker cannot resolve are forwarded to the persistent global
    container's DNS service through each chat container's --dns setting
  - Workspace, attachments, and shared directories are bind-mounted

Global environment model:
  - One persistent container per harness, named vulcan-global
  - Runs dnsmasq inside its own network namespace
  - dnsmasq forwards through whatever resolver configuration is active inside
    the global container, including VPN-provided DNS such as Tailscale MagicDNS
  - The user can manage the container through an interactive Settings terminal
  - Chat containers do not become separate VPN nodes

Image names:
  vulcan-workspace:latest — per-chat workspace image
  vulcan-global:latest    — persistent shared network environment
"""

from __future__ import annotations

import ipaddress
import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

from vulcan import config as cfg

IMAGE_NAME = "vulcan-workspace:latest"
GLOBAL_IMAGE_NAME = "vulcan-global:latest"
GLOBAL_CONTAINER = "vulcan-global"
GLOBAL_CHAT_ID = "global"
NETWORK_NAME = "vulcan"
GLOBAL_IP_STATE_FILE = "global_network.json"


def _is_windows() -> bool:
    return sys.platform == "win32"


def run_docker(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Run a Docker command, prepending `wsl` on Windows."""
    prefix = ["wsl"] if _is_windows() else []
    return subprocess.run(prefix + ["docker"] + args, **kwargs)


def docker_output(args: list[str]) -> str:
    result = run_docker(args, capture_output=True, text=True)
    return result.stdout.strip()


def _host_path(p: Path) -> str:
    if _is_windows():
        parts = p.parts
        drive = parts[0].rstrip(":\\").lower()
        rest = "/".join(parts[1:])
        return f"/mnt/{drive}/{rest}"
    return str(p)


def chat_uses_global_container(chat_id: str) -> bool:
    """Return True when a persisted chat is backed by the shared global container."""
    if chat_id == GLOBAL_CHAT_ID:
        return True
    try:
        path = cfg.CHATS_DIR / chat_id / "chat.json"
        if not path.exists():
            return False
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("containerScope") == "global"
    except Exception:
        return False


def container_name(chat_id: str) -> str:
    if chat_uses_global_container(chat_id):
        return GLOBAL_CONTAINER
    return f"vulcan-chat-{chat_id}"


def workspace_path(chat_id: str) -> str:
    """Working directory inside the backing container for this chat."""
    if chat_id == GLOBAL_CHAT_ID:
        return "/root"
    if chat_uses_global_container(chat_id):
        return f"/vulcan/chats/{chat_id}/workspace"
    return "/workspace"


def attachments_path(chat_id: str) -> str:
    if chat_uses_global_container(chat_id) and chat_id != GLOBAL_CHAT_ID:
        return f"/vulcan/chats/{chat_id}/attachments"
    return "/attachments"


DOCKERFILE = """\
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \\
    python3 \\
    python3-pip \\
    python3-venv \\
    git \\
    curl \\
    wget \\
    file \\
    build-essential \\
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /workspace
CMD ["/bin/bash"]
"""


GLOBAL_DOCKERFILE = """\
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \\
    dnsmasq \\
    iproute2 \\
    iptables \\
    nftables \\
    curl \\
    wget \\
    ca-certificates \\
    openssh-client \\
    nano \\
    less \\
    procps \\
    dnsutils \\
    && rm -rf /var/lib/apt/lists/*

# The global environment intentionally does not hard-code public resolvers.
# dnsmasq reads /etc/resolv.conf inside this container, so VPN clients and the
# user can change the effective resolver path without Vulcan understanding it.
RUN printf '%s\\n' \\
    'port=53' \\
    'listen-address=0.0.0.0' \\
    'bind-dynamic' \\
    'cache-size=1000' \\
    'neg-ttl=30' \\
    'log-facility=-' \\
    > /etc/dnsmasq.conf

RUN printf '%s\\n' \\
    '#!/bin/sh' \\
    'set -eu' \\
    'iptables -t nat -C POSTROUTING -s "${VULCAN_SUBNET}" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s "${VULCAN_SUBNET}" -j MASQUERADE' \\
    'exec dnsmasq --keep-in-foreground' \\
    > /usr/local/bin/vulcan-global-entrypoint \\
    && chmod +x /usr/local/bin/vulcan-global-entrypoint

RUN mkdir -p /vulcan/chats /shared

WORKDIR /root
CMD ["/usr/local/bin/vulcan-global-entrypoint"]
"""


def write_dockerfile() -> Path:
    path = cfg.CONFIG_DIR / "Dockerfile"
    path.write_text(DOCKERFILE, encoding="utf-8")
    return path


def write_global_dockerfile() -> Path:
    path = cfg.CONFIG_DIR / "Dockerfile.global"
    path.write_text(GLOBAL_DOCKERFILE, encoding="utf-8")
    return path


def ensure_network() -> bool:
    """Create the shared user-defined Docker network if needed."""
    result = run_docker(["network", "inspect", NETWORK_NAME], capture_output=True)
    if result.returncode == 0:
        return True
    result = run_docker(["network", "create", NETWORK_NAME], capture_output=True)
    return result.returncode == 0


def _network_data() -> dict | None:
    result = run_docker(["network", "inspect", NETWORK_NAME], capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        parsed = json.loads(result.stdout)
        return parsed[0] if parsed else None
    except (ValueError, TypeError, IndexError):
        return None


def network_subnet() -> str | None:
    data = _network_data()
    if not data:
        return None
    configs = data.get("IPAM", {}).get("Config", [])
    if not configs:
        return None
    return configs[0].get("Subnet")


def _global_state_path() -> Path:
    return cfg.CONFIG_DIR / GLOBAL_IP_STATE_FILE


def _saved_global_ip() -> str | None:
    try:
        data = json.loads(_global_state_path().read_text(encoding="utf-8"))
        value = data.get("ip")
        if value:
            ipaddress.ip_address(value)
            return value
    except Exception:
        pass
    return None


def _save_global_ip(value: str) -> None:
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _global_state_path().write_text(json.dumps({"ip": value}, indent=2), encoding="utf-8")


def _existing_global_ip() -> str | None:
    if not global_exists():
        return None
    out = docker_output([
        "inspect", "--format",
        f"{{{{.NetworkSettings.Networks.{NETWORK_NAME}.IPAddress}}}}",
        GLOBAL_CONTAINER,
    ])
    return out or None


def _select_global_ip() -> str | None:
    """Pick and persist a stable free address on the existing Vulcan network."""
    existing = _existing_global_ip()
    if existing:
        _save_global_ip(existing)
        return existing

    data = _network_data()
    if not data:
        return None

    ipam = data.get("IPAM", {}).get("Config", [])
    if not ipam or not ipam[0].get("Subnet"):
        return None

    network = ipaddress.ip_network(ipam[0]["Subnet"], strict=False)
    gateway_text = ipam[0].get("Gateway")
    gateway = ipaddress.ip_address(gateway_text) if gateway_text else next(network.hosts())
    used = {
        ipaddress.ip_address(item.get("IPv4Address", "").split("/")[0])
        for item in data.get("Containers", {}).values()
        if item.get("IPv4Address")
    }

    saved = _saved_global_ip()
    if saved:
        saved_ip = ipaddress.ip_address(saved)
        if saved_ip in network and (saved_ip not in used or saved == existing):
            return saved

    # Prefer gateway + 1 (normally the familiar .2), then scan a small range.
    candidate = gateway + 1
    for _ in range(64):
        if candidate in network and candidate not in used:
            value = str(candidate)
            _save_global_ip(value)
            return value
        candidate += 1
    return None


def list_running_containers() -> list[str]:
    result = run_docker(
        ["network", "inspect", NETWORK_NAME,
         "--format", "{{range .Containers}}{{.Name}}\n{{end}}"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return []
    chat_ids: list[str] = []
    for name in result.stdout.splitlines():
        name = name.strip()
        if name.startswith("vulcan-chat-"):
            chat_ids.append(name[len("vulcan-chat-"):])
    return chat_ids


def image_exists() -> bool:
    return run_docker(["image", "inspect", IMAGE_NAME], capture_output=True).returncode == 0


def build_image(verbose: bool = False) -> bool:
    dockerfile = write_dockerfile()
    args = ["build", "-t", IMAGE_NAME, "-f", str(dockerfile), str(cfg.CONFIG_DIR)]
    if not verbose:
        args.append("--quiet")
    result = run_docker(
        args,
        stdout=None if verbose else subprocess.DEVNULL,
        stderr=None if verbose else subprocess.DEVNULL,
    )
    return result.returncode == 0


def remove_image() -> bool:
    return run_docker(["rmi", IMAGE_NAME], capture_output=True).returncode == 0


def global_image_exists() -> bool:
    return run_docker(["image", "inspect", GLOBAL_IMAGE_NAME], capture_output=True).returncode == 0


def build_global_image(verbose: bool = False) -> bool:
    dockerfile = write_global_dockerfile()
    args = ["build", "-t", GLOBAL_IMAGE_NAME, "-f", str(dockerfile), str(cfg.CONFIG_DIR)]
    if not verbose:
        args.append("--quiet")
    result = run_docker(
        args,
        stdout=None if verbose else subprocess.DEVNULL,
        stderr=None if verbose else subprocess.DEVNULL,
    )
    return result.returncode == 0


def global_exists() -> bool:
    return run_docker(["container", "inspect", GLOBAL_CONTAINER], capture_output=True).returncode == 0


def global_running() -> bool:
    if not global_exists():
        return False
    return docker_output(["inspect", "--format", "{{.State.Running}}", GLOBAL_CONTAINER]) == "true"


def _tun_available() -> bool:
    if _is_windows():
        return subprocess.run(["wsl", "test", "-c", "/dev/net/tun"], capture_output=True).returncode == 0
    return Path("/dev/net/tun").exists()


def _global_mounts_ready() -> bool:
    """Whether the existing global container exposes chat workspaces and shared files."""
    if not global_exists():
        return False
    result = run_docker(["inspect", GLOBAL_CONTAINER], capture_output=True, text=True)
    if result.returncode != 0:
        return False
    try:
        data = json.loads(result.stdout)[0]
        destinations = {m.get("Destination") for m in data.get("Mounts", [])}
        return "/vulcan/chats" in destinations and "/shared" in destinations
    except Exception:
        return False


def _create_global_container(image_name: str, verbose: bool = False) -> bool:
    ip = _select_global_ip()
    if not ip:
        return False
    chats_root = _host_path(cfg.CHATS_DIR)
    shared_root = _host_path(cfg.SHARED_DIR)
    args = [
        "run", "-d",
        "--name", GLOBAL_CONTAINER,
        "--network", NETWORK_NAME,
        "--ip", ip,
        "--cap-add", "NET_ADMIN",
        "--cap-add", "NET_RAW",
        "--sysctl", "net.ipv4.ip_forward=1",
        "--restart", "unless-stopped",
        "--label", "vulcan.role=global",
        "--mount", f"type=bind,src={chats_root},dst=/vulcan/chats",
        "--mount", f"type=bind,src={shared_root},dst=/shared",
        "-e", f"VULCAN_SUBNET={network_subnet() or '0.0.0.0/0'}",
    ]
    if _tun_available():
        args += ["--device", "/dev/net/tun:/dev/net/tun"]
    args.append(image_name)
    result = run_docker(args, capture_output=not verbose)
    return result.returncode == 0


def _migrate_global_mounts(verbose: bool = False) -> bool:
    """One-time migration for pre-global-chat containers.

    Docker cannot add bind mounts to an existing container. Commit its current
    filesystem first so user-installed software/configuration survives, then
    recreate it with the workspace mounts required by Global Container chats.
    """
    migration_image = "vulcan-global:workspace-migration"
    existing_ip = _existing_global_ip()
    if existing_ip:
        _save_global_ip(existing_ip)
    was_running = global_running()
    if run_docker(["commit", GLOBAL_CONTAINER, migration_image], capture_output=not verbose).returncode != 0:
        return False
    if was_running:
        run_docker(["stop", GLOBAL_CONTAINER], capture_output=not verbose)
    if run_docker(["rm", GLOBAL_CONTAINER], capture_output=not verbose).returncode != 0:
        return False
    return _create_global_container(migration_image, verbose=verbose)


def ensure_global(verbose: bool = False) -> bool:
    """Ensure the persistent global environment exists, is mounted, and is running."""
    cfg.ensure_dirs()
    if not ensure_network():
        return False
    if not global_image_exists() and not global_exists() and not build_global_image(verbose=verbose):
        return False

    if global_exists() and not _global_mounts_ready():
        return _migrate_global_mounts(verbose=verbose)

    if global_running():
        return True
    if global_exists():
        return run_docker(["start", GLOBAL_CONTAINER], capture_output=not verbose).returncode == 0
    return _create_global_container(GLOBAL_IMAGE_NAME, verbose=verbose)

def stop_global() -> bool:
    if not global_exists():
        return True
    return run_docker(["stop", GLOBAL_CONTAINER], capture_output=True).returncode == 0


def restart_global() -> bool:
    if not global_exists():
        return ensure_global()
    return run_docker(["restart", GLOBAL_CONTAINER], capture_output=True).returncode == 0


def global_ip() -> str | None:
    existing = _existing_global_ip()
    if existing:
        return existing
    return _saved_global_ip()


def global_status() -> dict:
    exists = global_exists()
    running = global_running() if exists else False
    return {
        "image_exists": global_image_exists(),
        "container_exists": exists,
        "container_running": running,
        "container_name": GLOBAL_CONTAINER,
        "global_ip": global_ip(),
        "dns_ready": running,
        "tun_available": _tun_available(),
    }


def _gpu_available() -> bool:
    result = run_docker(["run", "--rm", "--gpus", "all", "ubuntu:24.04", "true"], capture_output=True)
    return result.returncode == 0


def container_exists(chat_id: str) -> bool:
    return run_docker(["container", "inspect", container_name(chat_id)], capture_output=True).returncode == 0


def container_running(chat_id: str) -> bool:
    if not container_exists(chat_id):
        return False
    return docker_output(["inspect", "--format", "{{.State.Running}}", container_name(chat_id)]) == "true"


def _configure_chat_gateway(chat_id: str) -> bool:
    """Use the global environment as the route of last resort.

    Docker-network routes remain more specific and continue to work directly;
    only traffic which does not match a local Docker route uses the global
    container as its default gateway.
    """
    ip = global_ip()
    if not ip:
        return False
    result = run_docker(
        ["exec", container_name(chat_id), "ip", "route", "replace", "default", "via", ip],
        capture_output=True,
    )
    return result.returncode == 0


def start_container(chat_id: str, verbose: bool = False, force_global: bool = False) -> bool:
    if force_global or chat_uses_global_container(chat_id):
        cfg.chat_dir(chat_id) if chat_id != GLOBAL_CHAT_ID else cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        return ensure_global(verbose=verbose)

    cfg.ensure_dirs()
    if not ensure_global(verbose=verbose):
        return False

    if container_running(chat_id):
        return _configure_chat_gateway(chat_id)
    if container_exists(chat_id):
        started = run_docker(["start", container_name(chat_id)], capture_output=not verbose).returncode == 0
        return started and _configure_chat_gateway(chat_id)

    workspace = _host_path(cfg.chat_workspace_dir(chat_id))
    attachments = _host_path(cfg.chat_attachments_dir(chat_id))
    shared = _host_path(cfg.SHARED_DIR)
    dns_ip = global_ip()
    if not dns_ip:
        return False

    # On user-defined networks Docker still exposes 127.0.0.11 inside the chat
    # container. --dns configures where Docker forwards names it cannot resolve,
    # preserving Docker-local service discovery before the global fallback.
    run_args = [
        "run", "-d",
        "--name", container_name(chat_id),
        "--network", NETWORK_NAME,
        "--dns", dns_ip,
        "--mount", f"type=bind,src={workspace},dst=/workspace",
        "--mount", f"type=bind,src={attachments},dst=/attachments,readonly",
        "--mount", f"type=bind,src={shared},dst=/shared",
        "--restart", "no",
        "--cap-add", "NET_ADMIN",
        "--security-opt", "seccomp=unconfined",
    ]
    if _gpu_available():
        run_args += ["--gpus", "all"]
    run_args += [IMAGE_NAME, "tail", "-f", "/dev/null"]
    created = run_docker(run_args, capture_output=not verbose).returncode == 0
    return created and _configure_chat_gateway(chat_id)


def stop_container(chat_id: str) -> bool:
    if chat_uses_global_container(chat_id):
        return True  # A single global chat must never stop the shared environment.
    if not container_exists(chat_id):
        return True
    return run_docker(["stop", container_name(chat_id)], capture_output=True).returncode == 0


def remove_container(chat_id: str) -> bool:
    if chat_uses_global_container(chat_id):
        return False  # Global-backed chats never own the shared container.
    stop_container(chat_id)
    if not container_exists(chat_id):
        return True
    return run_docker(["rm", container_name(chat_id)], capture_output=True).returncode == 0


def reset_container(chat_id: str, verbose: bool = False) -> bool:
    if chat_uses_global_container(chat_id):
        return restart_global()
    remove_container(chat_id)
    return start_container(chat_id, verbose=verbose)


def nuke_chat(chat_id: str, verbose: bool = False) -> bool:
    if chat_uses_global_container(chat_id):
        # Reset only this chat's workspace; never remove/restart the shared container.
        import shutil
        workspace = cfg.chat_workspace_dir(chat_id)
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.mkdir(parents=True, exist_ok=True)
        return ensure_global(verbose=verbose)
    import shutil
    remove_container(chat_id)
    workspace = cfg.chat_workspace_dir(chat_id)
    if workspace.exists():
        shutil.rmtree(workspace)
        workspace.mkdir()
    env_json = cfg.chat_environment_json(chat_id)
    if env_json.exists():
        env_json.unlink()
    return start_container(chat_id, verbose=verbose)


def exec_in_container(cmd: str, chat_id: str, timeout: int = 180, workdir: Optional[str] = None) -> subprocess.Popen:
    cwd = workdir or workspace_path(chat_id)
    docker_args = ["exec", "-i", "-w", cwd, container_name(chat_id), "/bin/bash", "-c", cmd]
    prefix = ["wsl"] if _is_windows() else []
    return subprocess.Popen(
        prefix + ["docker"] + docker_args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def container_ip(chat_id: str) -> Optional[str]:
    out = docker_output([
        "inspect", "--format",
        f"{{{{.NetworkSettings.Networks.{NETWORK_NAME}.IPAddress}}}}",
        container_name(chat_id),
    ])
    return out or None


def container_has_gpu(chat_id: str) -> bool:
    if chat_uses_global_container(chat_id):
        return False
    out = docker_output([
        "inspect", "--format", "{{range .HostConfig.DeviceRequests}}{{.Driver}}{{end}}",
        container_name(chat_id),
    ])
    return "nvidia" in out


def _container_dns(chat_id: str) -> list[str]:
    if not container_exists(chat_id):
        return []
    out = docker_output(["inspect", "--format", "{{json .HostConfig.Dns}}", container_name(chat_id)])
    try:
        value = json.loads(out)
        return value if isinstance(value, list) else []
    except Exception:
        return []


def _chat_default_gateway(chat_id: str) -> str | None:
    if not container_running(chat_id):
        return None
    result = run_docker(
        ["exec", container_name(chat_id), "sh", "-lc", "ip route show default | awk '{print $3; exit}'"],
        capture_output=True, text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def status(chat_id: str) -> dict:
    if chat_uses_global_container(chat_id):
        return {**global_status(), "gpu_enabled": False}
    exists = container_exists(chat_id)
    running = container_running(chat_id) if exists else False
    gpu = container_has_gpu(chat_id) if running else False
    dns = _container_dns(chat_id) if exists else []
    return {
        "image_exists": image_exists(),
        "container_exists": exists,
        "container_running": running,
        "gpu_enabled": gpu,
        "container_name": container_name(chat_id),
        "dns_servers": dns,
        "global_dns_configured": bool(global_ip() and global_ip() in dns),
        "default_gateway": _chat_default_gateway(chat_id),
        "global_gateway_configured": _chat_default_gateway(chat_id) == global_ip(),
    }
