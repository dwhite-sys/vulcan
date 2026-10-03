# Upstream terminal components

VS Code revision: `7b3839f429b5bd42e1b2657aa26f037cfa1a0c12`.

`vendor/shellIntegration-bash.sh` is an unmodified copy of
`src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh`
from https://github.com/microsoft/vscode at that revision. Microsoft's MIT
license is retained in `vendor/LICENSE.vscode`.

The host's OSC 633 adapter follows the upstream shell integration protocol:
A/B delimit the prompt, C begins execution, D carries command completion and
exit status, P reports cwd, and nonce-authenticated EnvSingleEntry reports
exported variables. The host never infers command completion from prompt text.

xterm headless and serialization components are pinned in package-lock.json.
A headless emulator alone answers live terminal device queries; historical
conversion and replay suppress input. Durable snapshots exclude alternate
buffers and modes, while live attachment snapshots include them.

Additional adapted sources at the same revision:
- `src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts`: OSC 633
  dispatch and `deserializeVSCodeOscMessage`, including escaped backslashes.
- `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts`:
  `_evaluateColsAndRows` and `_getDimension` (zero-size retention and padding).
- `src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`:
  `getXtermScaledDimensions` (device pixel scaling). The adapter uses xterm's
  actual device cell metrics, shared with its renderer, in place of font estimates.
- `src/vs/workbench/contrib/terminal/test/browser/xterm/shellIntegrationAddon.test.ts`:
  OSC decoding regression cases adapted to Node's test runner.

Vulcan's independent host and private protocol are new adapters, not copies of
VS Code's complete service graph. Their Docker ownership and checkpoint paths
are Vulcan-specific. `terminalDimensions.ts` retains upstream copyright.
