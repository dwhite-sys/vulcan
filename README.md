# Vulcan

This tree packages Vulcan as a normal Electron desktop product with a self-repairing backend runtime.

## Product contract

The desktop artifact is the entry point:

- Linux: `Vulcan-<version>-linux-<arch>.AppImage`
- Windows: `Vulcan-<version>-win-<arch>.exe` (NSIS)
- macOS: `Vulcan-<version>-mac-<arch>.dmg` containing `Vulcan.app`

Every packaged launch runs the same desired-state repair pass. There is no authoritative `firstRun` flag. Healthy components are left alone; missing or damaged components are recreated.

Electron owns the desktop process, tray behavior, native notifications, and window lifecycle. The platform install scripts own desired-state convergence: desktop integration where applicable, Vulcan's backend/runtime, Docker/workspace state, and service setup.


## One-command Linux install

Once a tagged GitHub release exists, Linux users can install the same AppImage used by the desktop download path with:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash
```

The public script does not build Vulcan from source. It downloads the stable `Vulcan.AppImage` release asset, verifies its SHA-256 from GitHub release metadata, atomically installs it at `~/.local/share/vulcan/app/Vulcan.AppImage`, and launches it. The packaged application then runs the same self-repairing convergence pass used on every normal launch.

A specific release can be selected without changing the script:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --release vX.Y.Z
```

### Headless / server-only

A Linux server does not need to download or install Electron at all:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --server-only
```

`--server-only` resolves the selected GitHub release tag, downloads GitHub's source tarball for that exact tag, and runs the tagged installer against only its `vulcan` server package. It converges Vulcan's managed Python/runtime, Docker/workspace state, and system service without creating desktop integration. Etna remains an independent host-level product: Vulcan may use Etna's public CLI to establish or repair Etna and required kits, but Vulcan does not own Etna's runtime or service lifecycle.

A specific headless release is selected the same way:

```bash
curl -fsSL https://raw.githubusercontent.com/dwhite-sys/vulcan/main/install.sh | bash -s -- --server-only --release vX.Y.Z
```

For development/private testing, `VULCAN_APPIMAGE_URL` together with `VULCAN_APPIMAGE_SHA256` can override the official desktop asset and digest. `VULCAN_SOURCE_TARBALL_URL` can override the tagged source archive used by the headless bootstrap path.

## Backend topology

- Linux: native Linux server + Docker Engine + systemd user service.
- Windows: native Electron + native Etna + dedicated `Vulcan` WSL2 Ubuntu 24.04 distro. Docker Engine and the Vulcan server run inside WSL2 under systemd.
- macOS: native Electron `.app` + native Etna + named Colima profile. Only the Vulcan server/runtime lives inside the Colima Linux VM; Colima/Lima automatically forwards guest port 8468 back to macOS localhost.

Etna deliberately stays on the host on all three platforms so client-POV kits such as Playwright can interact with the user's real desktop/browser. Vulcan owns its own managed Python/server runtime, Docker/workspace state, and Vulcan service. Etna owns its own lifecycle and is consumed by Vulcan over HTTP after any required public-CLI setup or repair.

## Build

```bash
cd vulcan-app
npm ci
npm run electron:build
```

`electron:build` hashes the bundled server payload before running Vite and electron-builder. The GitHub Actions workflow builds the same source on Linux, Windows, and macOS runners.

## Linux smoke test

Run the AppImage from Downloads. It should persist itself at `~/.local/share/vulcan/app/Vulcan.AppImage`, create or repair its launcher and autostart entry, converge the backend, and appear in the desktop application launcher. The process the user opened remains the first session; later launches use the persisted AppImage. Closing the window hides it to the tray; tray **Exit** terminates only the desktop process, not the supervised backend service.

`VULCAN_SKIP_REPAIR=1` skips packaged repair for development/debugging only.
