"""Docker-backed isolated chat workspaces using the host network namespace."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from vulcan import config as cfg

IMAGE_NAME = "vulcan-workspace:latest"
WORKSPACE_IMAGE_VERSION = "6"
LEGACY_GLOBAL_CONTAINER = "vulcan-global"


def _is_windows() -> bool:
    return sys.platform == "win32"


def run_docker(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Run Docker on Linux or through WSL on Windows."""
    prefix = ["wsl"] if _is_windows() else []
    return subprocess.run(prefix + ["docker"] + args, **kwargs)


def docker_output(args: list[str]) -> str:
    return run_docker(args, capture_output=True, text=True).stdout.strip()


def _host_path(path: Path) -> str:
    if _is_windows():
        parts = path.parts
        drive = parts[0].rstrip(":\\").lower()
        return f"/mnt/{drive}/{'/'.join(parts[1:])}"
    return str(path)


def container_name(chat_id: str) -> str:
    return f"vulcan-chat-{chat_id}"


def workspace_path(chat_id: str) -> str:
    return "/workspace"


def attachments_path(chat_id: str) -> str:
    return "/attachments"


def workspace_exec_flags(chat_id: str) -> list[str]:
    """Keep bind-mounted files owned by the host user, not container root."""
    if _is_windows() or not hasattr(os, "getuid"):
        return []
    return ["--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp/vulcan-home"]


def terminal_home(kind: str, slot: int) -> str:
    """Return the private HOME used by one logical terminal slot."""
    safe_kind = "agent" if kind == "agent" else "user"
    return f"/tmp/vulcan-terminal-homes/{safe_kind}-{int(slot)}"


def terminal_exec_flags(chat_id: str, kind: str, slot: int) -> list[str]:
    """Use the host uid/gid while isolating terminal dotfiles and SSH state per slot."""
    flags: list[str] = []
    if not _is_windows() and hasattr(os, "getuid"):
        flags += ["--user", f"{os.getuid()}:{os.getgid()}"]
    flags += [
        "-e", f"HOME={terminal_home(kind, slot)}",
        "-e", f"VULCAN_CHAT_ID={chat_id}",
        "-e", "VULCAN_NODE=vulcan",
    ]
    return flags


def prepare_terminal_identity(chat_id: str, kind: str, slot: int) -> bool:
    """Create a private HOME for one slot so shell/SSH state cannot bleed across terminals."""
    home = terminal_home(kind, slot)
    if _is_windows() or not hasattr(os, "getuid"):
        uid = gid = 0
    else:
        uid, gid = os.getuid(), os.getgid()
    script = (
        'home="$1"; uid="$2"; gid="$3"; '
        'mkdir -p "$home" "$home/.ssh"; '
        'chown -R "$uid:$gid" "$home"; '
        'chmod 700 "$home" "$home/.ssh"'
    )
    result = run_docker(
        ["exec", "--user", "0:0", container_name(chat_id), "/bin/sh", "-c", script,
         "vulcan-terminal-init", home, str(uid), str(gid)],
        capture_output=True, text=True,
    )
    return result.returncode == 0


def prepare_workspace_identity(chat_id: str) -> bool:
    """Repair older root-owned workspaces before opening a host-user shell."""
    if _is_windows() or not hasattr(os, "getuid"):
        return True
    uid, gid = os.getuid(), os.getgid()
    workdir = workspace_path(chat_id)
    script = (
        'uid="$1"; gid="$2"; workdir="$3"; '
        'mkdir -p /tmp/vulcan-home; '
        'chown "$uid:$gid" /tmp/vulcan-home; '
        'packages="sudo curl iputils-ping ca-certificates git openssh-client wget unzip zip tar gzip bzip2 xz-utils zstd jq ripgrep fd-find fzf less file procps psmisc iproute2 dnsutils netcat-openbsd lsof rsync build-essential pkg-config python3 python3-pip python3-venv sqlite3 tree nano"; '
        'missing=""; for pkg in $packages; do dpkg -s "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"; done; '
        'if [ -n "$missing" ]; then apt-get update && apt-get install -y $missing && rm -rf /var/lib/apt/lists/*; fi; '
        'if command -v fdfind >/dev/null 2>&1 && [ ! -e /usr/local/bin/fd ]; then ln -s /usr/bin/fdfind /usr/local/bin/fd; fi; '
        'if ! getent group "$gid" >/dev/null 2>&1; then groupadd -g "$gid" vulcan-host-group; fi; '
        'account="$(getent passwd "$uid" | cut -d: -f1)"; '
        'if [ -z "$account" ]; then useradd -u "$uid" -g "$gid" -d /tmp/vulcan-home -M -s /bin/bash vulcan-host; account=vulcan-host; fi; '
        'mkdir -p /etc/sudoers.d; printf "%s ALL=(ALL) NOPASSWD:ALL\\n" "$account" > /etc/sudoers.d/vulcan-host; chmod 440 /etc/sudoers.d/vulcan-host; visudo -cf /etc/sudoers.d/vulcan-host >/dev/null; '
        'if [ -d "$workdir" ]; then chown -R "$uid:$gid" "$workdir"; chmod -R u+rwX "$workdir"; fi; '
        'if [ -x /root/.local/bin/uv ] && [ ! -e /usr/local/bin/uv ]; then cp /root/.local/bin/uv /usr/local/bin/uv; chmod 755 /usr/local/bin/uv; fi; '
        'if [ -x /root/.local/bin/uvx ] && [ ! -e /usr/local/bin/uvx ]; then cp /root/.local/bin/uvx /usr/local/bin/uvx; chmod 755 /usr/local/bin/uvx; fi'
    )
    result = run_docker(
        ["exec", "--user", "0:0", container_name(chat_id), "/bin/sh", "-c", script,
         "vulcan-workspace-init", str(uid), str(gid), workdir],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


DOCKERFILE = """\
FROM ubuntu:24.04

LABEL vulcan.workspace.version="6"
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \\
    python3 \\
    python3-pip \\
    python3-venv \\
    sudo \\
    ca-certificates \\
    git \\
    openssh-client \\
    curl \\
    wget \\
    iputils-ping \\
    iproute2 \\
    dnsutils \\
    netcat-openbsd \\
    lsof \\
    procps \\
    psmisc \\
    jq \\
    ripgrep \\
    fd-find \\
    fzf \\
    less \\
    file \\
    tree \\
    tar \\
    gzip \\
    bzip2 \\
    xz-utils \\
    zstd \\
    zip \\
    unzip \\
    rsync \\
    build-essential \\
    pkg-config \\
    sqlite3 \\
    nano \\
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Interactive shells stay non-root; explicit sudo escalates only inside the chat container.
RUN printf 'ubuntu ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/vulcan-ubuntu \
    && chmod 0440 /etc/sudoers.d/vulcan-ubuntu

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /workspace
CMD ["/bin/bash"]
"""


def write_dockerfile() -> Path:
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    path = cfg.CONFIG_DIR / "Dockerfile"
    path.write_text(DOCKERFILE, encoding="utf-8")
    return path


def image_exists() -> bool:
    return run_docker(["image", "inspect", IMAGE_NAME], capture_output=True).returncode == 0


def image_current() -> bool:
    if not image_exists():
        return False
    version = docker_output([
        "image", "inspect", "--format", '{{index .Config.Labels "vulcan.workspace.version"}}', IMAGE_NAME,
    ])
    return version == WORKSPACE_IMAGE_VERSION


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


def retire_legacy_global_container() -> bool:
    """Remove the obsolete DNS/gateway container without touching chat files."""
    if run_docker(["container", "inspect", LEGACY_GLOBAL_CONTAINER], capture_output=True).returncode != 0:
        return True
    run_docker(["stop", LEGACY_GLOBAL_CONTAINER], capture_output=True)
    return run_docker(["rm", LEGACY_GLOBAL_CONTAINER], capture_output=True).returncode == 0


def list_running_containers() -> list[str]:
    result = run_docker(
        ["ps", "--filter", "name=vulcan-chat-", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []
    return [
        name[len("vulcan-chat-"):]
        for value in result.stdout.splitlines()
        if (name := value.strip()).startswith("vulcan-chat-")
    ]


def container_has_listening_service(chat_id: str) -> bool:
    """Detect TCP listeners owned by processes inside this chat container.

    Containers share the host network namespace, so checking for any listening
    address would incorrectly classify unrelated host services as belonging to
    every chat. `ss -p` resolves process details only for processes visible in
    this container's PID namespace; a `users:((` entry therefore identifies a
    listener actually owned by this container.
    """
    result = run_docker(
        ["exec", "--user", "0:0", container_name(chat_id), "ss", "-ltnpH"],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and "users:((" in (result.stdout or "")


def reconcile_orphan_terminal_processes() -> dict[str, int]:
    """Kill interactive terminal shells that survived a Vulcan server restart.

    The in-memory terminal registry cannot reattach to pre-existing docker-exec PTYs,
    so leaving them alive only creates duplicate logical slots on reconnect.
    """
    cleaned: dict[str, int] = {}
    for chat_id in list_running_containers():
        if chat_id == "global":
            continue
        name = container_name(chat_id)
        script = r'''count=0
for pid in $(ps -eo pid=,tty=,args= | awk '$2 ~ /^pts\// && $0 ~ /\/bin\/bash/ {print $1}'); do
  [ "$pid" = "$$" ] && continue
  kill -TERM "$pid" 2>/dev/null && count=$((count+1)) || true
done
sleep 0.05
for pid in $(ps -eo pid=,tty=,args= | awk '$2 ~ /^pts\// && $0 ~ /\/bin\/bash/ {print $1}'); do
  [ "$pid" = "$$" ] && continue
  kill -KILL "$pid" 2>/dev/null || true
done
printf '%s' "$count"'''
        result = run_docker(["exec", "--user", "0:0", name, "/bin/sh", "-c", script],
                            capture_output=True, text=True)
        if result.returncode == 0:
            try:
                cleaned[chat_id] = int((result.stdout or "0").strip() or "0")
            except ValueError:
                cleaned[chat_id] = 0
    return cleaned


def _gpu_available() -> bool:
    return run_docker(["run", "--rm", "--gpus", "all", "ubuntu:24.04", "true"], capture_output=True).returncode == 0


def container_exists(chat_id: str) -> bool:
    return run_docker(["container", "inspect", container_name(chat_id)], capture_output=True).returncode == 0


def container_running(chat_id: str) -> bool:
    if not container_exists(chat_id):
        return False
    return docker_output(["inspect", "--format", "{{.State.Running}}", container_name(chat_id)]) == "true"


def container_network_mode(chat_id: str) -> str | None:
    if not container_exists(chat_id):
        return None
    return docker_output(["inspect", "--format", "{{.HostConfig.NetworkMode}}", container_name(chat_id)]) or None


def container_hostname(chat_id: str) -> str | None:
    if not container_exists(chat_id):
        return None
    return docker_output(["inspect", "--format", "{{.Config.Hostname}}", container_name(chat_id)]) or None


def container_hostname_resolves(chat_id: str) -> bool:
    """The configured terminal hostname must resolve locally for sudo/getaddrinfo."""
    if not container_running(chat_id):
        return False
    result = run_docker(
        ["exec", "--user", "0:0", container_name(chat_id), "getent", "hosts", "vulcan"],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def container_library_is_read_only(chat_id: str) -> bool:
    """Cross-chat/library namespaces, including the absolute alias view, stay read-only."""
    from vulcan import library as library_store
    readonly_view = str(library_store.readonly_view_root().absolute())
    result = docker_output([
        "inspect", "--format",
        '{{range .Mounts}}{{.Destination}}={{if .RW}}rw{{else}}ro{{end}};{{end}}',
        container_name(chat_id),
    ])
    mounts = set(item for item in result.split(";") if item)
    return {"/shared/library=ro", "/chats=ro", f"{readonly_view}=ro"}.issubset(mounts)

def _migrate_container_to_host_network(chat_id: str, verbose: bool = False) -> str | None:
    """Preserve installed packages while applying current networking and protected mounts."""
    digest = hashlib.sha256(chat_id.encode("utf-8")).hexdigest()[:16]
    migrated_image = f"vulcan-workspace:host-network-{digest}"
    if run_docker(["commit", container_name(chat_id), migrated_image], capture_output=not verbose).returncode != 0:
        return None
    if container_running(chat_id):
        run_docker(["stop", container_name(chat_id)], capture_output=not verbose)
    if run_docker(["rm", container_name(chat_id)], capture_output=not verbose).returncode != 0:
        return None
    return migrated_image


def start_container(chat_id: str, verbose: bool = False) -> bool:
    cfg.ensure_dirs()
    cfg.chat_dir(chat_id)
    selected_image = IMAGE_NAME

    if container_exists(chat_id):
        if (container_network_mode(chat_id) == "host" and container_library_is_read_only(chat_id)
                and container_hostname(chat_id) == "vulcan"):
            if not container_running(chat_id):
                if run_docker(["start", container_name(chat_id)], capture_output=not verbose).returncode != 0:
                    return False
            # Older host-network containers used --hostname vulcan without a matching
            # hosts entry, which makes sudo emit "unable to resolve host vulcan".
            # Recreate those containers once with the current network identity.
            if container_hostname_resolves(chat_id):
                return True
        migrated = _migrate_container_to_host_network(chat_id, verbose=verbose)
        if not migrated:
            return False
        selected_image = migrated
    elif not image_exists() and not build_image(verbose=verbose):
        return False

    workspace = _host_path(cfg.chat_workspace_dir(chat_id))
    attachments = _host_path(cfg.chat_attachments_dir(chat_id))
    shared = _host_path(cfg.SHARED_DIR)
    library = _host_path(cfg.LIBRARY_DIR)
    from vulcan import library as library_store
    library_store.root()
    readonly_view_dst = str(library_store.readonly_view_root().absolute())
    chats = _host_path(cfg.CHATS_DIR)
    args = [
        "run", "-d",
        "--name", container_name(chat_id),
        "--network", "host",
        "--hostname", "vulcan",
        # Host networking does not provide a Docker-DNS record for this synthetic
        # hostname. Keep it locally resolvable so sudo/libc hostname lookups are clean.
        "--add-host", "vulcan:127.0.1.1",
        "--label", "vulcan.role=chat",
        "--label", f"vulcan.chat_id={chat_id}",
        "--mount", f"type=bind,src={workspace},dst=/workspace",
        "--mount", f"type=bind,src={attachments},dst=/attachments,readonly",
        "--mount", f"type=bind,src={shared},dst=/shared",
        "--mount", f"type=bind,src={library},dst=/shared/library,readonly",
        # Absolute workspace aliases resolve identically on host and in Docker,
        # while the container sees this stable Library view as read-only.
        "--mount", f"type=bind,src={library},dst={readonly_view_dst},readonly",
        "--mount", f"type=bind,src={chats},dst=/chats,readonly",
        "--restart", "no",
    ]
    if _gpu_available():
        args += ["--gpus", "all"]
    args += [selected_image, "tail", "-f", "/dev/null"]
    return run_docker(args, capture_output=not verbose).returncode == 0


def stop_container(chat_id: str) -> bool:
    if not container_exists(chat_id):
        return True
    return run_docker(["stop", container_name(chat_id)], capture_output=True).returncode == 0


def remove_container(chat_id: str) -> bool:
    stop_container(chat_id)
    if not container_exists(chat_id):
        return True
    return run_docker(["rm", container_name(chat_id)], capture_output=True).returncode == 0


def reset_container(chat_id: str, verbose: bool = False) -> bool:
    remove_container(chat_id)
    return start_container(chat_id, verbose=verbose)


def nuke_chat(chat_id: str, verbose: bool = False) -> bool:
    import shutil

    remove_container(chat_id)
    workspace = cfg.chat_workspace_dir(chat_id)
    if workspace.exists():
        shutil.rmtree(workspace)
        workspace.mkdir()
    environment = cfg.chat_environment_json(chat_id)
    if environment.exists():
        environment.unlink()
    return start_container(chat_id, verbose=verbose)


def exec_in_container(cmd: str, chat_id: str, timeout: int = 180, workdir: Optional[str] = None) -> subprocess.Popen:
    cwd = workdir or workspace_path(chat_id)
    args = ["exec", "-i", *workspace_exec_flags(chat_id), "-w", cwd, container_name(chat_id), "/bin/bash", "-c", cmd]
    prefix = ["wsl"] if _is_windows() else []
    return subprocess.Popen(
        prefix + ["docker"] + args,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def container_ip(chat_id: str) -> Optional[str]:
    """Dashboard proxies reach host-networked container services through loopback."""
    if not container_running(chat_id):
        return None
    if container_network_mode(chat_id) == "host":
        return "127.0.0.1"
    value = docker_output([
        "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container_name(chat_id),
    ])
    return value or None


def container_has_gpu(chat_id: str) -> bool:
    value = docker_output([
        "inspect", "--format", "{{range .HostConfig.DeviceRequests}}{{.Driver}}{{end}}", container_name(chat_id),
    ])
    return "nvidia" in value


def status(chat_id: str) -> dict:
    exists = container_exists(chat_id)
    running = container_running(chat_id) if exists else False
    network_mode = container_network_mode(chat_id) if exists else None
    return {
        "image_exists": image_exists(),
        "container_exists": exists,
        "container_running": running,
        "gpu_enabled": container_has_gpu(chat_id) if running else False,
        "container_name": container_name(chat_id),
        "network_mode": network_mode,
        "host_network": network_mode == "host",
    }
