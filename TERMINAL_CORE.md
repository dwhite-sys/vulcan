# Terminal core replacement

Based on GitHub main `4fd80a8cc94e36e5aaae4ccb86071ae2b2789fe1` (rc37). Historical archives and older Git revisions were diagnostic references, not the implementation base.

## Causes and replacement

The old prompt put invisible OSC bytes into readline's printable prompt width, producing early wraps and overwrites. tmux filtered command markers, leaving completed commands reported as running. Raw scrollback replay answered historical device queries into the shell, accumulating junk. Several earlier prompt, passthrough and replay fixes had subsequently been reverted.

New sessions use an independent Node host with node-pty, headless xterm and serialization, directly owning Docker-exec PTYs. Python retains container policy, authentication and tool interfaces. The private Unix protocol is version 1; its directory/socket/checkpoints have restricted permissions. The encrypted client transport is preserved.

VS Code's unmodified Bash integration and adapted OSC decoding, command boundaries and dimension methods are pinned to one upstream revision. Attribution, exact paths and adapted tests are in `vulcan/terminal_host/UPSTREAM.md` and `vendor/LICENSE.vscode`.

The headless emulator owns live terminal replies and rendered tool output. Historical conversion and buffer replay cannot send input. Geometry changes and output share an ordered queue; generation/sequence cursors recover coherent snapshots. The viewer uses actual xterm device cell metrics after layout/font measurement, retains dimensions while hidden, restores snapshots at recorded geometry and then requests current dimensions.

## Lifecycle and migration

Closing a window detaches its viewers. App/backend disconnection leaves the host and shells alive. Reopening reconnects to the same shell when it exists. Host/PC or container process loss restores checkpointed history into a fresh shell, preserving known cwd and exported environment and reporting unfinished commands as interrupted. Commands are never automatically rerun. Docker can retain an inner Bash after its outer exec client dies; revival retires only the old shell identified by its verified token and PID before launching its replacement.

Atomic, fsynced checkpoints save serialized normal-buffer history, dimensions, launch state, environment and command records; slot identity/focus continue using Vulcan's existing atomic metadata. Clean host service shutdown checkpoints current state. Abrupt power/process loss can lose output since the last one-second checkpoint. Shell environment/cwd reflect the last integrated prompt, rather than guessing state during a running command.

Open terminals retain existing default container idle protection; terminal inactivity auto-close is disabled. Explicit close/container-stop remain deliberate lifecycle actions. Active legacy tmux sessions stay in place and regain prompt delimiters/passthrough markers at an untouched idle prompt. Legacy history is converted in an inputless emulator and original data is backed up. New/replaced sessions use the host.

The current `install.sh` provisions a checksum-verified private Node runtime, pinned dependencies and a separate systemd user/system service through `vulcan.terminal_runtime`; Windows and macOS use their existing Linux backend guests. `setup.sh` is not used. Provisioning keeps an already running host alive and health checks report missing/incompatible runtime dependencies.

## Validation

Observed locally on Linux:

- 27 Node tests: real Bash status and environment, upstream OSC cases, isolated query replay, multiline commands, Unicode/colors/progress, private no-echo password takeover, Ctrl-C followed by another command, and real full-screen Vim resizing/alternate-buffer restoration.
- Actual `TerminalSlotWidget` in Chromium against a Docker PTY: narrow/wide geometry, long input/editing over wrap boundaries, inner Docker `stty` agreement, rapid layout changes, delayed font loading, hidden zero-size retention, reopen/reconnect, no page errors.
- Python tools against Docker: dimensions, rendered output, command status, manual busy detection, interruption, same-shell backend reconnect, environment/cwd, host kill with accurate interrupted status and no rerun, and container stop/restart revival.
- Real legacy tmux migration: original shell PID/exported environment preserved, completion markers restored, explicit close retires the session.
- 46 existing real PTY/container-lifecycle tests; four provisioning tests covering checksum rejection, archive containment, atomic installation and independent service ownership.
- Actual private Node download/checksum/dependency build and health in a temporary installation.
- Isolated transient systemd user service: backend connection exit preserves the host/shell; clean service stop saves current history.
- rc38 Linux AppImage build; existing packaging/authenticated transport/password/update regressions.

CI builds Linux, Windows and macOS packages and runs Docker/widget/provisioning behavior on Linux. Physical Windows/macOS installation and an actual PC reboot have not been performed locally; process-loss and container restart were exercised directly. Source-string packaging checks are supplementary and are not counted as terminal behavior proof.

No installation into the user's live Vulcan or public release publication is part of this source delivery. The rc38 tag workflow creates a draft release for separate publication.
