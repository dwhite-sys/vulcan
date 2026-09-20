# Validation status

This packaging candidate was assembled from the r24 Vulcan source donor and the SimpleMCP V2 Electron packaging pattern.

Validated in the build environment:

- `bash -n install.sh`
- Electron CommonJS syntax for `main.cjs`, `preload.cjs`, and `installCoordinator.cjs`
- `scripts/packaging-regression.mjs`
- deterministic packaged-server payload hashing
- Python bytecode compilation
- Python package build/install using the packaged `pyproject.toml`
- installed `vulcan` package imports and packaged `agent_assets/tool_schemas.json`
- full server Python suite: **200 passed, 22 subtests passed**

Not field-tested here:

- actual AppImage execution / KDE tray integration
- Polkit Docker installation on Arch/Fedora/Ubuntu
- Windows NSIS + WSL2 bootstrap
- macOS DMG + Colima bootstrap

A full Vite/electron-builder build was not completed in this container because package installation could not reach npm. The source-side packaging regression and Electron syntax checks pass; the next meaningful test is `npm ci && npm run electron:build` on the target/build runner, followed by launching the resulting artifact.

## GitHub one-command Linux bootstrap

Validated after adding the public `curl | bash` path:

- `bash -n install.sh` passes.
- `vulcan-app/scripts/packaging-regression.mjs` passes with assertions for the standalone bootstrap, stable release aliases, all three CI runners, and release publishing.
- `.github/workflows/build.yml` parses as YAML and now builds on pull requests to `main`, pushes to `main`, tags, and manual dispatch.
- A local fake-AppImage harness exercised the complete network-bootstrap control flow: download, SHA-256 verification, stable AppImage installation, `--appimage-extract`, discovery of the embedded `resources/install.sh`, and delegation to that embedded converger using the installed AppImage path.
- The release workflow produces stable aliases `Vulcan.AppImage`, `Vulcan-Setup.exe`, and `Vulcan.dmg` plus SHA-256 sidecars while retaining electron-builder's versioned outputs.

The bootstrap test deliberately used a fake AppImage payload so it did not modify the host's Docker, systemd, Etna, or desktop state. A real end-to-end AppImage build still requires a runner with npm registry access; GitHub Actions is intended to provide that environment.

## Headless `--server-only`

Validated after adding the headless path:

- `bash -n install.sh` still passes.
- `scripts/packaging-regression.mjs` now asserts the `--server-only` parser, headless bootstrap, server release bundle, linger wiring, and workflow asset.
- The GitHub workflow now builds `Vulcan-Server.tar.gz` and `Vulcan-Server.tar.gz.sha256` on the Linux runner alongside the AppImage. A local reproduction of that workflow step produced a 322 KiB bundle with the expected `install.sh`, `server-payload.sha256`, and filtered `vulcan-server/` tree.
- A fake server-bundle harness exercised the public headless control flow end to end: download, SHA-256 verification, extraction, and delegation to the bundled converger with `--server-only`, `--server-source`, and `--server-hash-file`. It did not persist or invoke an AppImage.
- Native Linux `--server-only` uses a system-level `vulcan.service` and prefers `sudo` for privileged operations, while normal graphical repair retains the Polkit-first path. The installer enables systemd user lingering so Etna's user service can survive logout.

Still requires real-machine validation: Docker installation/group transition and the resulting boot-persistent systemd service on a headless Arch/Ubuntu/Fedora host.

## GitHub Actions upstream hardening (repackage v3)

The first GitHub Actions run (`35482298763`) was inspected through the GitHub connector. All three runners reached Vite successfully and then failed at the same electron-builder schema validation: Linux desktop-entry keys were placed directly under `linux.desktop` instead of `linux.desktop.entry`.

Run `35484266021` confirmed that the desktop-entry schema fix works and that Node 24 reaches real Electron packaging on Linux, macOS, and Windows. All three then failed because electron-builder implicitly entered publish mode under CI and could not infer repository metadata from the nested app package. That run also exposed that the live repository's broad `build/` ignore rule had prevented the application icon assets from ever being committed.

This repackage fixes both issues and hardens them against regression:

- `linux.desktop.entry` now uses the electron-builder v26 schema.
- `vulcan-app/build/` is no longer swallowed by the repository's generic `build/` ignore rule, so `icon.png`, `icon.ico`, `icon.icns`, and tray icon assets can actually be committed.
- generated Python `vulcan/build/`, `vulcan/dist/`, and `*.egg-info/` remain ignored instead.
- the repository layout is guarded so `vulcan/` must be the Python backend itself, not a nested duplicate of the whole repository.
- `electron:build` runs the packaging regression and explicitly passes `--publish never`; GitHub Releases are published only by the dedicated release job, avoiding electron-builder v26 CI auto-publishing.
- the workflow no longer injects `GH_TOKEN` into electron-builder.
- GitHub actions are moved off their Node-20-based action runtimes (`actions/checkout@v6`, `actions/setup-node@v7`).
- the build runtime is Node 24, while package metadata requires `>=22.12.0`; the locked Electron 43.3.0 package itself requires Node `>=22.12.0`.
- a dependency-free packaging preflight runs before `npm ci`, so missing PNG/ICO/ICNS/tray icons, an icon-swallowing `.gitignore`, a duplicated repo tree, or malformed builder metadata fail immediately instead of after dependency installation.
- artifact uploads use `if-no-files-found: error`, and the release step fails if its file glob matches nothing.

Revalidated after these changes:

- `bash -n install.sh`
- Electron CommonJS syntax
- packaging preflight with no generated server hash present
- runtime hash generation followed by packaging regression
- workflow YAML parse
- Python suite: **200 passed, 22 subtests passed**

A complete local `npm ci`/electron-builder build is still not claimed from this container; npm registry access stalled here. GitHub Actions remains the authoritative full packaging test for Linux, Windows, and macOS.
