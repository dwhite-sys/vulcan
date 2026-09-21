# Validation status

Vulcan's packaging path is built around an on-every-launch desired-state convergence pass rather than a separate first-run installer.

## Source-side validation

The repository currently validates:

- `bash -n install.sh`
- `vulcan-app/scripts/packaging-regression.mjs`
- deterministic packaged-server payload hashing
- Electron packaging metadata and required icon assets
- Linux headless source bootstrap
- Python package/runtime imports and server tests
- Linux, Windows, and macOS packaging through GitHub Actions

The convergence contract is that each subtask observes actual state, skips healthy state, repairs only the smallest missing or stale component, and verifies the result.

## Current platform contract

- **Linux:** native Vulcan server, managed Vulcan Python runtime, Docker Engine, and systemd supervision. Desktop integration is repaired only when missing or stale.
- **Windows:** native Electron and native host Etna; Vulcan's Linux backend and Docker run in the dedicated `Vulcan` WSL2 distro.
- **macOS:** native Electron and native host Etna; Vulcan's Linux backend and Docker run in the named Colima profile `vulcan`.
- **Etna:** independently host-owned on all platforms. Vulcan may invoke Etna's public CLI for installation, initialization, or required kits, then communicates with Etna over HTTP. Vulcan does not own an Etna virtual environment or service.
- **Workspace:** the Docker image and semantic/lexical recall assets are checked independently and healthy state is skipped.
- **Services:** Vulcan and Docker service state is changed only when disabled, inactive, missing, or stale.

## Release/bootstrap contract

Desktop releases publish:

- `Vulcan.AppImage`
- `Vulcan-Setup.exe`
- `Vulcan.dmg`

SHA-256 values are written into the GitHub release body. Linux and Windows standalone bootstrap code prefer GitHub's per-asset digest when available and otherwise use that release-body SHA-256 table.

Linux `--server-only` resolves an exact release tag and downloads that tag's GitHub source tarball. It does not install Electron or desktop integration.

## Remaining real-machine validation

Source and CI checks cannot replace first-run validation on actual hosts. The remaining high-value field tests are:

- Linux Docker installation plus initial docker-group transition
- Windows WSL2 enable/reboot/import flow
- macOS first-time Colima installation/startup
- AppImage desktop/tray behavior on representative Linux desktops
