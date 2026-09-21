"""
vulcan/cli.py — Vulcan command-line interface

Commands:
  vulcan install               First-time setup (or status if already set up)
  vulcan start                 Start the Vulcan server
  vulcan start --verbose       Start with full log output
  vulcan stop                  Stop the Vulcan server
  vulcan restart               Restart the Vulcan server
  vulcan status                Show server, container, and workspace summary

  vulcan container start       Start the Docker workspace container
  vulcan container stop        Stop the Docker workspace container
  vulcan container rebuild     Nuke and rebuild the container image

  vulcan workspace list        List all chat workspaces with sizes
  vulcan workspace delete <id> Delete a specific chat workspace
  vulcan workspace clear       Delete all chat workspaces (with confirmation)

  vulcan config get <key>      Get a config value
  vulcan config set <key> <val> Set a config value

  vulcan set-password          Set (or change) the server authentication password
  vulcan clear-password        Remove the server authentication password
"""

import argparse
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from vulcan import config as cfg
from vulcan import docker, workspace
from vulcan import auth


# ── Console helpers ───────────────────────────────────────────────────────────

def _green(s: str) -> str:  return f"\033[32m{s}\033[0m"
def _red(s: str) -> str:    return f"\033[31m{s}\033[0m"
def _yellow(s: str) -> str: return f"\033[33m{s}\033[0m"
def _bold(s: str) -> str:   return f"\033[1m{s}\033[0m"
def _dim(s: str) -> str:    return f"\033[2m{s}\033[0m"

def ok(msg: str):   print(f"  {_green('✓')} {msg}")
def fail(msg: str): print(f"  {_red('✗')} {msg}")
def info(msg: str): print(f"  {_dim('·')} {msg}")
def warn(msg: str): print(f"  {_yellow('!')} {msg}")


# ── Server PID management ─────────────────────────────────────────────────────

def _write_pid(pid: int):
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    cfg.PID_FILE.write_text(str(pid))


def _read_pid() -> int | None:
    if not cfg.PID_FILE.exists():
        return None
    try:
        return int(cfg.PID_FILE.read_text().strip())
    except ValueError:
        return None


def _clear_pid():
    if cfg.PID_FILE.exists():
        cfg.PID_FILE.unlink()


def _server_running() -> bool:
    pid = _read_pid()
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        _clear_pid()
        return False


# ── Platform: desktop entry / startup registration ────────────────────────────

def _register_app():
    """Register Vulcan as an installed application on the current platform."""
    system = platform.system()

    if system == "Linux":
        desktop = Path.home() / ".local" / "share" / "applications" / "vulcan.desktop"
        vulcan_bin = shutil.which("vulcan") or "vulcan"
        desktop.parent.mkdir(parents=True, exist_ok=True)
        desktop.write_text(
            "[Desktop Entry]\n"
            "Name=Vulcan\n"
            "Comment=Vulcan orchestration service\n"
            f"Exec={vulcan_bin} start\n"
            "Icon=utilities-terminal\n"
            "Type=Application\n"
            "Categories=Utility;Development;\n"
            "NoDisplay=false\n"
        )
        ok("Registered .desktop entry")

    elif system == "Darwin":
        # Create a simple launchd plist for auto-start + app bundle stub
        plist_dir  = Path.home() / "Library" / "LaunchAgents"
        plist_path = plist_dir / "com.dwhite.vulcan.plist"
        vulcan_bin = shutil.which("vulcan") or "vulcan"
        plist_dir.mkdir(parents=True, exist_ok=True)
        plist_path.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0"><dict>\n'
            '  <key>Label</key><string>com.dwhite.vulcan</string>\n'
            f'  <key>ProgramArguments</key><array>'
            f'<string>{vulcan_bin}</string><string>start</string></array>\n'
            '  <key>RunAtLoad</key><true/>\n'
            '  <key>KeepAlive</key><false/>\n'
            '</dict></plist>\n'
        )
        ok("Registered launchd plist (auto-start on login)")

    elif system == "Windows":
        import winreg
        vulcan_bin = shutil.which("vulcan") or "vulcan"
        key_path   = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE)
            winreg.SetValueEx(key, "Vulcan", 0, winreg.REG_SZ, f'"{vulcan_bin}" start')
            winreg.CloseKey(key)
            ok("Registered startup entry (Run key)")
        except Exception as e:
            warn(f"Could not register startup entry: {e}")

        # Start Menu shortcut
        start_menu = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
        shortcut   = start_menu / "Vulcan.lnk"
        try:
            import winshell  # type: ignore
            with winshell.shortcut(str(shortcut)) as link:
                link.path        = vulcan_bin
                link.description = "Vulcan orchestration service"
            ok("Created Start Menu shortcut")
        except ImportError:
            info("Install 'winshell' for Start Menu shortcut support")
        except Exception as e:
            warn(f"Could not create Start Menu shortcut: {e}")


# ── WSL2 detection + installation (Windows) ───────────────────────────────────

def _check_wsl2() -> bool:
    """Return True if running inside WSL2 or if WSL2 is available on Windows."""
    if platform.system() != "Windows":
        return True  # Not Windows — no WSL2 needed

    # Check if wsl.exe is available
    result = subprocess.run(["wsl", "--status"], capture_output=True, text=True)
    return result.returncode == 0


def _install_wsl2():
    """Attempt to install WSL2 on Windows via elevated PowerShell."""
    print()
    print(_bold("  Vulcan requires WSL2 to run on Windows."))
    print()

    print("  Attempting to launch installer via elevated PowerShell...")
    try:
        subprocess.run([
            "powershell", "-Command",
            "Start-Process powershell -ArgumentList 'wsl --install' -Verb RunAs",
        ])
        print()
        ok("WSL2 installation launched.")
        print()
        print("  Please reboot your machine, then:")
        print("    1. Open your WSL2 terminal (Ubuntu)")
        print("    2. Run: vulcan install")
        print()
    except Exception:
        print()
        warn("Could not launch elevated PowerShell automatically.")
        print()
        print("  Please install WSL2 manually:")
        print("    1. Open PowerShell as Administrator")
        print("    2. Run: wsl --install")
        print("    3. Reboot your machine")
        print("    4. Open your WSL2 terminal (Ubuntu)")
        print("    5. Run: vulcan install")
        print()


# ── Docker check ──────────────────────────────────────────────────────────────

def _check_docker() -> bool:
    result = docker.run_docker(["info"], capture_output=True)
    return result.returncode == 0


def _install_docker_linux():
    """Attempt to install Docker Engine on Linux."""
    print()
    info("Docker not found. Attempting to install...")
    result = subprocess.run(
        ["bash", "-c", "curl -fsSL https://get.docker.com | sh"],
        capture_output=False,
    )
    if result.returncode == 0:
        # Fix permissions
        user = os.environ.get("USER", "")
        if user:
            subprocess.run(["sudo", "usermod", "-aG", "docker", user], capture_output=True)
            warn(f"Added {user} to docker group. You may need to log out and back in.")
        return True
    return False


# ── Install command ───────────────────────────────────────────────────────────

def cmd_install(args):
    print()
    print(_bold("  Vulcan Setup"))
    print()

    runtime_only = bool(getattr(args, "runtime_only", False))

    # Platform acquisition belongs to the packaged install.sh/install.ps1 path.
    # The CLI retains its legacy standalone acquisition behavior unless invoked
    # by that converger with --runtime-only.
    if not runtime_only and platform.system() == "Windows":
        if not _check_wsl2():
            _install_wsl2()
            return
        ok("WSL2 available")

    if not _check_docker():
        if runtime_only:
            fail("Docker is not reachable; packaged installer must repair Docker first")
            return
        system = platform.system()
        if system == "Linux":
            if not _install_docker_linux():
                fail("Failed to install Docker. Install it manually: https://docs.docker.com/engine/install/")
                return
            if not _check_docker():
                fail("Docker installed but not reachable. Try logging out and back in.")
                return
            ok("Docker installed")
        else:
            fail("Docker not found. Install Docker Desktop (macOS) or Docker Engine (Linux/WSL2).")
            return
    else:
        ok("Docker available")

    # ── Config dir ────────────────────────────────────────────────────────────
    cfg.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    cfg.ensure_dirs()
    ok(f"Config directory: {cfg.CONFIG_DIR}")

    # ── Default config ────────────────────────────────────────────────────────
    if not cfg.CONFIG_FILE.exists():
        cfg.save(cfg.DEFAULT_CONFIG.copy())
        ok("Created default config")
    else:
        info("Config already exists")

    # ── Docker image ──────────────────────────────────────────────────────────
    if docker.image_current():
        info("Docker image already built")
    else:
        print()
        info("Building current Docker workspace image with SSH (~30s)...")
        if docker.build_image(verbose=args.verbose):
            ok("Docker image built")
        else:
            fail("Failed to build Docker image")
            return

    # Repair only missing recall assets.
    print()
    try:
        from vulcan import recall

        state = recall.status()

        if state["semantic_downloaded"]:
            info("Semantic recall model already ready")
        else:
            semantic = recall.download_semantic_model()
            ok(f"BGE-small semantic encoder ready ({semantic['dimensions']} dimensions)")

        if state["lexical_ready"]:
            info("Lexical recall bank already ready")
        else:
            lexical = recall.build_lexical_bank()
            ok(f"spaCy lexical embedding bank ready: {lexical['path']}")
    except Exception as exc:
        warn(f"Recall models could not be prepared: {exc}")
        info("The server will retry automatically when it starts.")

    # Desktop registration is owned by the packaged Electron artifact.  Keep
    # the legacy CLI behavior only when this command is used standalone.
    if not runtime_only:
        _register_app()

    # ── Done ──────────────────────────────────────────────────────────────────
    print()
    print(_bold("  Vulcan is ready."))
    print()
    print("  Start the server:    vulcan start")
    print("  Check status:        vulcan status")
    print()


# ── Start / stop / restart ────────────────────────────────────────────────────

def cmd_start(args):
    if _server_running():
        warn("Vulcan is already running.")
        return

    config   = cfg.load()
    port     = config.get("port", cfg.DEFAULT_PORT)

    # Start server as a background process
    env = os.environ.copy()
    env["VULCAN_CONFIG_DIR"] = str(cfg.CONFIG_DIR)

    if args.verbose:
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "vulcan.server:app",
             "--host", "0.0.0.0", "--port", str(port)],
            env=env,
        )
    else:
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "vulcan.server:app",
             "--host", "0.0.0.0", "--port", str(port),
             "--log-level", "error"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )

    _write_pid(proc.pid)

    # Wait for server to be ready
    import urllib.request
    for _ in range(20):
        time.sleep(0.3)
        try:
            urllib.request.urlopen(f"http://localhost:{port}/ping", timeout=1)
            ok(f"Vulcan started on port {port}")
            # Note: per-chat containers are started on demand when chats are opened,
            # not at server startup.
            return
        except Exception:
            continue

    warn("Server started but did not respond in time. Check: vulcan status")



def cmd_serve(args):
    """Run the Vulcan server in the foreground for systemd/launch supervision."""
    config = cfg.load()
    port = config.get("port", cfg.DEFAULT_PORT)
    env = os.environ.copy()
    env["VULCAN_CONFIG_DIR"] = str(cfg.CONFIG_DIR)
    argv = [
        sys.executable, "-m", "uvicorn", "vulcan.server:app",
        "--host", "0.0.0.0", "--port", str(port),
        "--log-level", "info" if getattr(args, "verbose", False) else "error",
    ]
    os.execve(sys.executable, argv, env)


def cmd_stop(args):
    pid = _read_pid()
    if pid is None or not _server_running():
        warn("Vulcan is not running.")
        return

    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
        if _server_running():
            os.kill(pid, signal.SIGKILL)
        _clear_pid()
        ok("Vulcan stopped")
    except Exception as e:
        fail(f"Could not stop Vulcan: {e}")


def cmd_restart(args):
    cmd_stop(args)
    time.sleep(0.5)
    cmd_start(args)


# ── Status ────────────────────────────────────────────────────────────────────

def cmd_status(args):
    print()
    print(_bold("  Vulcan Status"))
    print()

    # Server
    if _server_running():
        pid = _read_pid()
        ok(f"Server running (PID {pid})")
    else:
        fail("Server not running")

    # Docker
    print()
    if docker.image_exists():
        ok("Docker image built")
    else:
        fail("Docker image not built — run: vulcan install")

    running = docker.list_running_containers()
    if running:
        ok(f"Running containers: {len(running)}")
        for cid in running:
            info(f"  vulcan-chat-{cid[:12]}…")
    else:
        info("No containers currently running (started on demand per chat)")

    # Workspaces
    print()
    workspaces = workspace.list_workspaces()
    if workspaces:
        info(f"Chat workspaces: {len(workspaces)}")
        total = sum(w["sizeBytes"] for w in workspaces)
        info(f"Total size: {total / 1024 / 1024:.1f} MB")
    else:
        info("No chat workspaces yet")

    # Config
    print()
    config = cfg.load()
    info(f"Config: {cfg.CONFIG_FILE}")
    info(f"Port:   {config.get('port', cfg.DEFAULT_PORT)}")
    print()


# ── Container subcommands ─────────────────────────────────────────────────────

def cmd_container(args):
    sub = args.container_cmd

    if sub == "list":
        running = docker.list_running_containers()
        if not running:
            info("No Vulcan containers currently running.")
            return
        print()
        print(_bold("  Running Vulcan Containers"))
        print()
        for cid in running:
            print(f"  vulcan-chat-{cid}")
        print()

    elif sub == "stop":
        chat_id = args.chat_id
        if not chat_id:
            fail("Usage: vulcan container stop <chat-id>")
            return
        if docker.stop_container(chat_id):
            ok(f"Container stopped for chat {chat_id[:12]}…")
        else:
            fail(f"Failed to stop container for chat {chat_id[:12]}…")

    elif sub == "rebuild-image":
        print()
        warn("This will remove and rebuild the base Docker image.")
        warn("Running containers will not be affected until they are reset.")
        print()
        confirm = input("  Proceed? [y/N] ").strip().lower()
        if confirm != "y":
            info("Aborted.")
            return
        print()
        info("Removing old image...")
        docker.remove_image()
        info("Building new image (this may take ~30s)...")
        if docker.build_image(verbose=args.verbose):
            ok("Image rebuilt")
        else:
            fail("Rebuild failed")


# ── Workspace subcommands ─────────────────────────────────────────────────────

def cmd_workspace(args):
    sub = args.workspace_cmd

    if sub == "list":
        workspaces = workspace.list_workspaces()
        if not workspaces:
            info("No workspaces found.")
            return
        print()
        print(_bold("  Chat Workspaces"))
        print()
        for w in workspaces:
            size_mb = w["sizeBytes"] / 1024 / 1024
            title   = w.get("chatTitle") or _dim("(no title)")
            print(f"  {w['chatId'][:12]}…  {size_mb:6.1f} MB  {title}")
        print()

    elif sub == "delete":
        chat_id = args.chat_id
        confirm = input(f"  Delete workspace {chat_id}? [y/N] ").strip().lower()
        if confirm != "y":
            info("Aborted.")
            return
        workspace.delete_workspace(chat_id)
        ok(f"Deleted workspace {chat_id}")

    elif sub == "clear":
        workspaces = workspace.list_workspaces()
        if not workspaces:
            info("No workspaces to clear.")
            return
        print()
        warn(f"This will delete {len(workspaces)} workspace(s).")
        confirm = input("  Proceed? [y/N] ").strip().lower()
        if confirm != "y":
            info("Aborted.")
            return
        for w in workspaces:
            workspace.delete_workspace(w["chatId"])
            info(f"Deleted {w['chatId'][:12]}…")
        ok("All workspaces cleared")


# ── Config subcommands ────────────────────────────────────────────────────────

def cmd_config(args):
    sub = args.config_cmd
    config = cfg.load()

    if sub == "get":
        keys  = args.key.split(".")
        value = config
        for k in keys:
            if isinstance(value, dict):
                value = value.get(k)
            else:
                value = None
                break
        if value is None:
            fail(f"Key not found: {args.key}")
        else:
            print(json.dumps(value, indent=2))

    elif sub == "set":
        keys  = args.key.split(".")
        value = args.value
        # Try to parse as JSON (handles numbers, booleans, etc.)
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            pass  # Keep as string

        # Set nested key
        target = config
        for k in keys[:-1]:
            target = target.setdefault(k, {})
        target[keys[-1]] = value
        cfg.save(config)
        ok(f"Set {args.key} = {json.dumps(value)}")


# ── Password management ───────────────────────────────────────────────────────

def cmd_set_password(args):
    import getpass
    print()
    print(_bold("  Set Vulcan server password"))
    print()
    if auth.has_server_password():
        info("A server password is already set. Entering a new one will replace it.")
        print()

    while True:
        password = getpass.getpass("  Enter new password: ")
        if not password:
            fail("Password cannot be empty.")
            continue
        confirm = getpass.getpass("  Confirm password: ")
        if password != confirm:
            fail("Passwords do not match. Try again.")
            print()
            continue
        break

    try:
        auth.set_server_password(password)
        print()
        ok("Server password set. The server will require authentication on next start.")
        info("Clients connecting remotely will need to provide this password.")
        print()
    except Exception as e:
        fail(f"Failed to set password: {e}")


def cmd_clear_password(args):
    import getpass
    print()
    if not auth.has_server_password():
        info("No server password is set — server is already running unauthenticated.")
        print()
        return

    print(_bold("  Clear Vulcan server password"))
    print()
    warn("This will allow any client to connect to the server without authentication.")
    print()
    confirm = input("  Type 'yes' to confirm: ").strip().lower()
    if confirm != "yes":
        info("Aborted.")
        print()
        return

    auth.clear_server_password()
    print()
    ok("Server password cleared. Server will run unauthenticated on next start.")
    print()


def cmd_recall(args):
    """Download recall assets, build the lexical bank, or inspect/search it."""
    from vulcan import recall

    if args.recall_cmd == "status":
        print(json.dumps(recall.status(), indent=2))
        return
    if args.recall_cmd == "download-bge":
        print(json.dumps(recall.download_semantic_model(), indent=2))
        return
    if args.recall_cmd == "build-bank":
        print(json.dumps(recall.build_lexical_bank(args.bank, force=args.force), indent=2))
        return
    if args.recall_cmd == "setup":
        result = {}
        if not args.skip_lexical:
            result["lexical"] = recall.build_lexical_bank(args.bank, force=args.force)
        if not args.skip_semantic:
            result["semantic"] = recall.download_semantic_model()
        print(json.dumps(result, indent=2))
        return
    if args.recall_cmd == "search":
        print(json.dumps(recall.search(args.query, mode=args.mode, limit=args.limit), indent=2))
        return
    print("Usage: vulcan recall {setup,build-bank,download-bge,status,search}")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog="vulcan",
        description="Vulcan — LLM orchestration server",
    )
    sub = parser.add_subparsers(dest="command")

    # install
    p_install = sub.add_parser("install", help="Install or repair Vulcan runtime state")
    p_install.add_argument("--verbose", action="store_true")
    p_install.add_argument("--runtime-only", action="store_true", help="Skip OS/runtime acquisition and desktop registration")

    # start
    p_start = sub.add_parser("start", help="Start the Vulcan server")
    p_start.add_argument("--verbose", action="store_true")

    # foreground service entry point
    p_serve = sub.add_parser("serve", help="Run the Vulcan server in the foreground")
    p_serve.add_argument("--verbose", action="store_true")

    # stop
    sub.add_parser("stop", help="Stop the Vulcan server")

    # restart
    p_restart = sub.add_parser("restart", help="Restart the Vulcan server")
    p_restart.add_argument("--verbose", action="store_true")

    # status
    sub.add_parser("status", help="Show status summary")

    # container
    p_container = sub.add_parser("container", help="Docker container management")
    p_container.add_argument("--verbose", action="store_true")
    container_sub = p_container.add_subparsers(dest="container_cmd")
    container_sub.add_parser("list", help="List running Vulcan containers")
    p_con_stop = container_sub.add_parser("stop", help="Stop a specific chat container")
    p_con_stop.add_argument("chat_id", nargs="?", default=None)
    container_sub.add_parser("rebuild-image", help="Remove and rebuild the base Docker image")

    # workspace
    p_workspace = sub.add_parser("workspace", help="Workspace management")
    ws_sub = p_workspace.add_subparsers(dest="workspace_cmd")
    ws_sub.add_parser("list", help="List all workspaces")
    p_ws_del = ws_sub.add_parser("delete", help="Delete a workspace")
    p_ws_del.add_argument("chat_id")
    ws_sub.add_parser("clear", help="Delete all workspaces")

    # config
    p_config = sub.add_parser("config", help="Config management")
    cfg_sub = p_config.add_subparsers(dest="config_cmd")
    p_cfg_get = cfg_sub.add_parser("get", help="Get a config value")
    p_cfg_get.add_argument("key")
    p_cfg_set = cfg_sub.add_parser("set", help="Set a config value")
    p_cfg_set.add_argument("key")
    p_cfg_set.add_argument("value")

    # set-password
    sub.add_parser("set-password", help="Set or change the server authentication password")

    # clear-password
    sub.add_parser("clear-password", help="Remove the server authentication password")

    # recall assets and database search
    p_recall = sub.add_parser("recall", help="Configure lexical and semantic chat recall")
    recall_sub = p_recall.add_subparsers(dest="recall_cmd")
    p_recall_setup = recall_sub.add_parser("setup", help="Download BGE-small and build the spaCy lexical bank")
    p_recall_setup.add_argument("--bank", help="Lexical bank directory; defaults to ~/.vulcan/semantic_bank")
    p_recall_setup.add_argument("--force", action="store_true", help="Rebuild an existing lexical bank")
    p_recall_setup.add_argument("--skip-lexical", action="store_true")
    p_recall_setup.add_argument("--skip-semantic", action="store_true")
    p_recall_bank = recall_sub.add_parser("build-bank", help="Download spaCy and build the lexical embedding bank")
    p_recall_bank.add_argument("--bank", help="Lexical bank directory; defaults to ~/.vulcan/semantic_bank")
    p_recall_bank.add_argument("--force", action="store_true")
    recall_sub.add_parser("download-bge", help="Download the ONNX-backed BGE-small semantic model")
    recall_sub.add_parser("status", help="Show lexical bank and semantic model status")
    p_recall_search = recall_sub.add_parser("search", help="Search server-owned chat history")
    p_recall_search.add_argument("query")
    p_recall_search.add_argument("--mode", choices=["lexical", "semantic"], default="lexical")
    p_recall_search.add_argument("--limit", type=int, default=8)

    args = parser.parse_args()

    dispatch = {
        "install":        cmd_install,
        "start":          cmd_start,
        "serve":          cmd_serve,
        "stop":           cmd_stop,
        "restart":        cmd_restart,
        "status":         cmd_status,
        "container":      cmd_container,
        "workspace":      cmd_workspace,
        "config":         cmd_config,
        "set-password":   cmd_set_password,
        "clear-password": cmd_clear_password,
        "recall":         cmd_recall,
    }

    if args.command in dispatch:
        dispatch[args.command](args)
    else:
        # No command — show status if set up, otherwise hint to install
        if cfg.CONFIG_FILE.exists():
            args_ns = argparse.Namespace()
            cmd_status(args_ns)
        else:
            print()
            print(_bold("  Vulcan"))
            print()
            info("Not yet set up. Run: vulcan install")
            print()


if __name__ == "__main__":
    main()
