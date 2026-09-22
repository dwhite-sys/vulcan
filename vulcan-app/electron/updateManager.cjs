const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { once } = require('events');

const RELEASES_URL = 'https://api.github.com/repos/dwhite-sys/vulcan/releases?per_page=30';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const ASSET_BY_PLATFORM = {
  linux: 'Vulcan.AppImage',
  win32: 'Vulcan-Setup.exe',
  darwin: 'Vulcan.dmg',
};

function parseVersion(raw) {
  const text = String(raw || '').trim().replace(/^v/i, '');
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:[-.]?(alpha|beta|rc)[.-]?(\d+))?$/i);
  if (!match) return null;
  return {
    raw: text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    label: match[4] ? match[4].toLowerCase() : null,
    pre: match[5] ? Number(match[5]) : null,
  };
}

function prereleaseRank(label) {
  if (!label) return 3;
  if (label === 'alpha') return 0;
  if (label === 'beta') return 1;
  if (label === 'rc') return 2;
  return 1;
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  const ar = prereleaseRank(a.label);
  const br = prereleaseRank(b.label);
  if (ar !== br) return ar > br ? 1 : -1;
  if (a.label || b.label) {
    const ap = Number(a.pre ?? 0);
    const bp = Number(b.pre ?? 0);
    if (ap !== bp) return ap > bp ? 1 : -1;
  }
  return 0;
}

function displayVersion(parsed) {
  if (!parsed) return '';
  return parsed.label
    ? `v${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.label}${parsed.pre ?? ''}`
    : `v${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function shaFromRelease(release, asset) {
  const digest = String(asset?.digest || '');
  const digestMatch = digest.match(/^sha256:([a-f0-9]{64})$/i);
  if (digestMatch) return digestMatch[1].toLowerCase();

  const name = String(asset?.name || '');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = String(release?.body || '');
  const tableMatch = body.match(new RegExp(
    `\\|\\s*\`?${escaped}\`?\\s*\\|\\s*\`?([a-f0-9]{64})\`?\\s*\\|`,
    'i',
  ));
  return tableMatch ? tableMatch[1].toLowerCase() : null;
}

function sanitizeState(state) {
  if (!state?.available) return {
    available: false,
    currentVersion: state?.currentVersion || app.getVersion(),
  };
  return {
    available: true,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    tag: state.tag,
    releaseUrl: state.releaseUrl,
    assetName: state.assetName,
  };
}

function createUpdater({ getMainWindow, onStateChanged }) {
  let state = { available: false, currentVersion: app.getVersion() };
  let checkPromise = null;
  let installPromise = null;
  let periodicTimer = null;

  const emitState = () => {
    try { onStateChanged?.(sanitizeState(state)); } catch {}
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send('vulcan-update-state', sanitizeState(state));
    }
  };

  const emitProgress = (payload) => {
    const win = getMainWindow?.();
    if (win && !win.isDestroyed()) win.webContents.send('vulcan-update-progress', payload);
  };

  async function check() {
    if (!app.isPackaged) return sanitizeState(state);
    if (checkPromise) return checkPromise;

    checkPromise = (async () => {
      const current = parseVersion(app.getVersion());
      if (!current) return sanitizeState(state);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await net.fetch(RELEASES_URL, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': `Vulcan/${app.getVersion()}`,
            'x-github-api-version': '2022-11-28',
          },
        });
        if (!response.ok) throw new Error(`GitHub releases returned HTTP ${response.status}`);
        const releases = await response.json();
        const assetName = ASSET_BY_PLATFORM[process.platform];
        if (!assetName || !Array.isArray(releases)) return sanitizeState(state);

        const candidates = [];
        for (const release of releases) {
          if (release?.draft) continue;
          const version = parseVersion(release?.tag_name);
          if (!version) continue;

          // Stable installs follow stable releases only. Alpha/beta/RC installs
          // remain on the preview channel and may also advance to the final
          // stable release for the same/newer line.
          if (!current.label && version.label) continue;
          if (compareVersions(version, current) <= 0) continue;

          const asset = Array.isArray(release?.assets)
            ? release.assets.find((item) => item?.name === assetName)
            : null;
          if (!asset?.browser_download_url) continue;

          const sha256 = shaFromRelease(release, asset);
          if (!sha256) continue; // never offer an unverifiable binary
          candidates.push({ release, version, asset, sha256 });
        }

        candidates.sort((a, b) => compareVersions(b.version, a.version));
        const chosen = candidates[0];
        if (!chosen) {
          const hadUpdate = state.available;
          state = { available: false, currentVersion: app.getVersion() };
          if (hadUpdate) emitState();
          return sanitizeState(state);
        }

        state = {
          available: true,
          currentVersion: app.getVersion(),
          latestVersion: displayVersion(chosen.version),
          tag: String(chosen.release.tag_name),
          releaseUrl: String(chosen.release.html_url || ''),
          assetName: String(chosen.asset.name),
          assetUrl: String(chosen.asset.browser_download_url),
          sha256: chosen.sha256,
        };
        emitState();
        return sanitizeState(state);
      } catch (error) {
        // Discovery must never interfere with startup.
        console.warn('[Vulcan updater] update check failed:', error?.message || error);
        return sanitizeState(state);
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { checkPromise = null; });

    return checkPromise;
  }

  function openPrompt() {
    const win = getMainWindow?.();
    if (!state.available || !win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('vulcan-update-open', sanitizeState(state));
  }

  async function streamDownload(url, target, expectedSha) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    try {
      const response = await net.fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': `Vulcan/${app.getVersion()}` },
      });
      if (!response.ok || !response.body) {
        throw new Error(`Update download returned HTTP ${response.status}`);
      }

      const total = Number(response.headers.get('content-length') || 0);
      const source = Readable.fromWeb(response.body);
      const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o700 });
      const hash = crypto.createHash('sha256');
      let received = 0;

      try {
        for await (const chunk of source) {
          hash.update(chunk);
          received += chunk.length;
          if (!output.write(chunk)) await once(output, 'drain');
          emitProgress({
            phase: 'download',
            received,
            total,
            percent: total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : null,
          });
        }
        output.end();
        await once(output, 'finish');
      } catch (error) {
        output.destroy();
        throw error;
      }

      const actual = hash.digest('hex').toLowerCase();
      if (actual !== String(expectedSha).toLowerCase()) {
        throw new Error('Downloaded update failed SHA-256 verification');
      }
      emitProgress({ phase: 'verified', percent: 100 });
    } finally {
      clearTimeout(timer);
    }
  }

  function writeUnixHelper(contents) {
    const helper = path.join(os.tmpdir(), `vulcan-update-${process.pid}-${Date.now()}.sh`);
    fs.writeFileSync(helper, contents, { mode: 0o700 });
    return helper;
  }

  function spawnDetached(command, args) {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  function scheduleLinuxApply(downloadPath) {
    const target = path.join(
      process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
      'vulcan', 'app', 'Vulcan.AppImage',
    );
    const helper = writeUnixHelper(`#!/bin/bash
set -euo pipefail
pid=${process.pid}
src=${JSON.stringify(downloadPath)}
dst=${JSON.stringify(target)}
while kill -0 "$pid" 2>/dev/null; do sleep 0.15; done
mkdir -p "$(dirname "$dst")"
tmp="$dst.new"
cp -f "$src" "$tmp"
chmod 0755 "$tmp"
mv -f "$tmp" "$dst"
rm -f "$src" "$0"
nohup "$dst" >/dev/null 2>&1 &
`);
    spawnDetached('/bin/bash', [helper]);
  }

  function scheduleWindowsApply(downloadPath) {
    const helper = path.join(os.tmpdir(), `vulcan-update-${process.pid}-${Date.now()}.ps1`);
    const exe = process.execPath;
    const q = (value) => `'${String(value).replace(/'/g, "''")}'`;
    fs.writeFileSync(helper, `
$ErrorActionPreference = 'Stop'
$pidToWait = ${process.pid}
$installer = ${q(downloadPath)}
$appExe = ${q(exe)}
while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 150 }
$process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { exit $process.ExitCode }
Remove-Item -Force $installer -ErrorAction SilentlyContinue
Start-Process -FilePath $appExe
Remove-Item -Force $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue
`, 'utf8');
    spawnDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper]);
  }

  function macBundlePath() {
    const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
    const exe = process.execPath;
    const idx = exe.indexOf(marker);
    if (idx > 0) return exe.slice(0, idx);
    return '/Applications/Vulcan.app';
  }

  function scheduleMacApply(downloadPath) {
    const target = macBundlePath();
    const mount = path.join(os.tmpdir(), `vulcan-update-mount-${process.pid}-${Date.now()}`);
    const helper = writeUnixHelper(`#!/bin/bash
set -euo pipefail
pid=${process.pid}
dmg=${JSON.stringify(downloadPath)}
mount=${JSON.stringify(mount)}
target=${JSON.stringify(target)}
while kill -0 "$pid" 2>/dev/null; do sleep 0.15; done
mkdir -p "$mount"
cleanup() {
  hdiutil detach "$mount" >/dev/null 2>&1 || true
  rm -rf "$mount"
  rm -f "$dmg"
}
trap cleanup EXIT
hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" >/dev/null
source_app="$(find "$mount" -maxdepth 1 -type d -name 'Vulcan.app' -print -quit)"
test -n "$source_app"
rm -rf "$target.new"
ditto "$source_app" "$target.new"
rm -rf "$target"
mv "$target.new" "$target"
open "$target"
rm -f "$0"
`);
    spawnDetached('/bin/bash', [helper]);
  }

  async function install() {
    if (!state.available) throw new Error('No Vulcan update is available');
    if (installPromise) return installPromise;

    installPromise = (async () => {
      const suffix = path.extname(state.assetName) || '.update';
      const target = path.join(os.tmpdir(), `vulcan-update-${state.tag}-${Date.now()}${suffix}`);
      try {
        emitProgress({ phase: 'starting', percent: 0 });
        await streamDownload(state.assetUrl, target, state.sha256);
        emitProgress({ phase: 'installing', percent: 100 });

        if (process.platform === 'linux') scheduleLinuxApply(target);
        else if (process.platform === 'win32') scheduleWindowsApply(target);
        else if (process.platform === 'darwin') scheduleMacApply(target);
        else throw new Error(`Unsupported update platform: ${process.platform}`);

        emitProgress({ phase: 'restarting', percent: 100 });
        setTimeout(() => app.quit(), 350);
        return { ok: true };
      } catch (error) {
        try { fs.rmSync(target, { force: true }); } catch {}
        emitProgress({ phase: 'error', message: error?.message || String(error) });
        throw error;
      }
    })().finally(() => { installPromise = null; });

    return installPromise;
  }

  function startPeriodicChecks() {
    if (periodicTimer || !app.isPackaged) return;
    periodicTimer = setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
    periodicTimer.unref?.();
  }

  return {
    check,
    install,
    openPrompt,
    startPeriodicChecks,
    getState: () => sanitizeState(state),
  };
}

module.exports = {
  createUpdater,
  parseVersion,
  compareVersions,
  displayVersion,
  shaFromRelease,
};
