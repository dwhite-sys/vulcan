# Vulcan

This tree packages Vulcan as a normal Electron desktop product with a self-repairing backend runtime.

## Product contract

The desktop artifact is the entry point:

- Linux: `Vulcan-<version>-linux-<arch>.AppImage`
- Windows: `Vulcan-<version>-win-<arch>.exe` (NSIS)
- macOS: `Vulcan-<version>-mac-<arch>.dmg` containing `Vulcan.app`

Every packaged launch runs the same desired-state repair pass. There is no authoritative `firstRun` flag. Healthy components are left alone; missing or damaged components are recreated.

Electron owns application installation/integration, tray behavior, login startup where appropriate, native notifications, and window lifecycle. `install.sh` and `install.ps1` own CLI-oriented backend setup.


## One-command Linux install
Linux users can install the same AppImage used by the desktop download path with:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash
```

The public script does not build Vulcan from source. It downloads the stable `Vulcan.AppImage` release asset, verifies it against the SHA-256 digest published by GitHub's release API, installs it at `~/.local/share/vulcan/app/Vulcan.AppImage`, extracts its bundled resources without requiring FUSE, and invokes the exact same self-repairing converger Electron invokes on normal launches. The installed desktop entry, icon, autostart entry, backend runtime, Etna kits, Docker state, and Vulcan service therefore converge through one implementation regardless of whether installation started by double-clicking the AppImage or piping the GitHub script to Bash.

A specific release can be selected without changing the script:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --release vX.Y.Z
```

### Headless / server-only

A Linux server does not need to download or install Electron at all:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --server-only
```

`--server-only` resolves the selected GitHub release tag, downloads GitHub's source tarball for that exact tag, and runs the tagged installer against only its `vulcan` server package. It installs/repairs uv, managed Python, Etna + required kits, Docker, the Vulcan runtime, and the workspace image, but creates no AppImage, `.desktop` entry, icon, tray autostart, or other desktop integration. Native Linux server-only installs use `/etc/systemd/system/vulcan.service` so the backend starts at boot and survives SSH logout; Etna remains a user service and the installer enables systemd user lingering for that account.

A specific headless release is selected the same way:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --server-only --release vX.Y.Z
```

For development/private testing, `VULCAN_APPIMAGE_URL` together with `VULCAN_APPIMAGE_SHA256` can override the official desktop asset and digest. `VULCAN_SOURCE_TARBALL_URL` can override the tagged source archive used by the headless bootstrap path.

## Backend topology

- Linux: native Linux server + Docker Engine + systemd user service.
- Windows: native Electron + native Etna + dedicated `Vulcan` WSL2 Ubuntu 24.04 distro. Docker Engine and the Vulcan server run inside WSL2 under systemd.
- macOS: native Electron `.app` + native Etna + named Colima profile. Only the Vulcan server/runtime lives inside the Colima Linux VM; Colima/Lima automatically forwards guest port 8468 back to macOS localhost.

Etna deliberately stays on the desktop host on all three platforms so client-POV kits such as Playwright can interact with the user's real desktop/browser. The repair scripts establish uv-managed Python, Etna plus recommended kits (`web`, `playwright`, `ntfy`), the packaged Vulcan server runtime, Docker availability, and the Vulcan service.

## Build

```bash
cd vulcan-app
npm ci
npm run electron:build
```

`electron:build` hashes the bundled server payload before running Vite and electron-builder. The GitHub Actions workflow builds the same source on Linux, Windows, and macOS runners.

## Linux smoke test

Run the AppImage from Downloads. It should copy itself to `~/.local/share/vulcan/app/Vulcan.AppImage`, create a launcher and autostart entry, repair the backend, relaunch from the stable copy, and appear in the desktop application launcher. Closing the window hides it to the tray; tray **Exit** terminates only the desktop process, not the supervised backend service.

`VULCAN_SKIP_REPAIR=1` skips packaged repair for development/debugging only.

## Windows troubleshooting and smoke test

Vulcan targets Windows 11 with WSL2 and hardware virtualization enabled. Repair
operates on its named `Vulcan` distro without changing your default WSL version.
If Windows asks for a restart while enabling WSL, restart and reopen Vulcan.

A Python Scripts-directory PATH warning is not evidence that WSL import failed.
The repair dialog reports WSL's native exit code and error text. Failed repairs also
save full installer output in `repair.log` in the desktop app's user-data directory
(the dialog gives its actual location). Include that file and these PowerShell
results in bug reports:

```powershell
wsl --version
wsl --status
wsl --list --verbose
```

For WSL error `0x80370102`, check firmware virtualization and the Virtual Machine
Platform Windows feature, then restart. For kernel/update errors, follow Microsoft's
[WSL troubleshooting guide](https://learn.microsoft.com/windows/wsl/troubleshooting).
Do not unregister an existing Vulcan distro to troubleshoot: it contains local data.

Before releasing a Windows installer, test on a current Windows 11 machine:

1. Install from a path and user profile containing spaces; allow WSL elevation if requested.
2. After any requested restart, reopen Vulcan and confirm the backend and Docker become healthy.
3. Create a chat and workspace, run a terminal command, and use native Etna browser tools.
4. Exit and reopen after `wsl --terminate Vulcan`; confirm cold startup works.
5. Run repair again; confirm existing chats/workspaces survive and other WSL distros are untouched.
6. Check tray close/Exit, login startup, and the update installer handoff.

The desktop app holds a WSL session while running (including in the tray), because
systemd services alone do not keep WSL alive. Routine repair preserves other
`wsl.conf` settings and does not terminate the distro unless boot settings change.
That preserves terminal sessions through ordinary repairs and updates.

CI tests PowerShell 5.1 parsing and simulated install/repair flows on Windows. The repair
coordinator tests error selection, log retention, reboot handling, and resource paths
with spaces. These tests do not replace a real WSL2 installation smoke test.
