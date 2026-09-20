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
