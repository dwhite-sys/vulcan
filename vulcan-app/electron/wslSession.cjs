const { spawn } = require('child_process');

// systemd services alone do not keep WSL alive. An open stdin connection gives
// the desktop app a Linux process for its lifetime, including time in the tray.
function createWslSession({ spawnProcess = spawn, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let child = null;
  let retry = null;
  let stopped = true;
  function start() {
    stopped = false;
    if (child || retry) return;
    let launched;
    try {
      launched = spawnProcess('wsl.exe', ['-d', 'Vulcan', '-u', 'vulcan', '--exec', 'bash', '-c', 'cat >/dev/null'], {
        windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch { reconnect(); return; }
    child = launched;
    launched.stdin.on('error', () => {});
    let finished = false;
    const closed = () => {
      if (finished) return;
      finished = true;
      if (child === launched) child = null;
      reconnect();
    };
    launched.once('error', closed);
    launched.once('close', closed);
  }
  function reconnect() {
    if (stopped || retry) return;
    retry = schedule(() => { retry = null; start(); }, 5000);
    retry?.unref?.();
  }
  function stop() {
    stopped = true;
    if (retry) cancel(retry);
    retry = null;
    const launched = child;
    child = null;
    // EOF ends cat and releases the WSL connection without terminating the distro.
    if (launched) { try { launched.stdin.end(); } catch {} }
  }
  return { start, stop };
}
module.exports = { createWslSession };
