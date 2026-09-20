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

Once a tagged GitHub release exists, Linux users can install the same AppImage used by the desktop download path with:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash
```

The public script does not build Vulcan from source. It downloads the release asset `Vulcan.AppImage` plus `Vulcan.AppImage.sha256`, verifies the SHA-256, installs the AppImage at `~/.local/share/vulcan/app/Vulcan.AppImage`, extracts its bundled resources without requiring FUSE, and invokes the exact same self-repairing converger Electron invokes on normal launches. The installed desktop entry, icon, autostart entry, backend runtime, Etna kits, Docker state, and Vulcan service therefore converge through one implementation regardless of whether installation started by double-clicking the AppImage or piping the GitHub script to Bash.

A specific release can be selected without changing the script:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --release vX.Y.Z
```

### Headless / server-only

A Linux server does not need to download or install Electron at all:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --server-only
```

`--server-only` downloads the much smaller `Vulcan-Server.tar.gz` release bundle instead of the AppImage. It installs/repairs uv, managed Python, Etna + required kits, Docker, the Vulcan runtime, and the workspace image, but creates no AppImage, `.desktop` entry, icon, tray autostart, or other desktop integration. Native Linux server-only installs use `/etc/systemd/system/vulcan.service` so the backend starts at boot and survives SSH logout; Etna remains a user service and the installer enables systemd user lingering for that account.

A specific headless release is selected the same way:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --server-only --release vX.Y.Z
```

For development/private testing, `VULCAN_APPIMAGE_URL` / `VULCAN_APPIMAGE_SHA256_URL` override the desktop release assets, while `VULCAN_SERVER_BUNDLE_URL` / `VULCAN_SERVER_BUNDLE_SHA256_URL` override the headless bundle URLs.

## Backend topology

- Linux: native Linux server + Docker Engine + systemd user service.
- Windows: native Electron + native Etna + dedicated `Vulcan` WSL2 Ubuntu 24.04 distro. Docker Engine and the Vulcan server run inside WSL2 under systemd.
- macOS: native Electron `.app` + native Etna + named Colima profile. Only the Vulcan server/runtime lives inside the Colima Linux VM; Colima/Lima automatically forwards guest port 8468 back to macOS localhost.

Etna deliberately stays on the desktop host on all three platforms so client-POV kits such as Playwright can interact with the user's real desktop/browser. The repair scripts establish uv-managed Python, Etna plus required kits (`web`, `playwright`, `ntfy`), the packaged Vulcan server runtime, Docker availability, and the Vulcan service.

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
