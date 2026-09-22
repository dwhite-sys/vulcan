const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function parseResult(output) {
  const lines = String(output || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.startsWith('VULCAN_RESULT=')) continue;
    try { return JSON.parse(line.slice('VULCAN_RESULT='.length)); }
    catch { return null; }
  }
  return null;
}

function parseProgressLine(line) {
  const value = String(line || '').trim();
  if (!value.startsWith('VULCAN_PROGRESS=')) return null;
  try {
    const payload = JSON.parse(value.slice('VULCAN_PROGRESS='.length));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

const STAGE_COPY = {
  checking: {
    title: 'Preparing local runtime',
    detail: 'Checking existing installation…',
  },
  python: {
    title: 'Preparing Python runtime',
    detail: 'Creating Vulcan-managed Python environment…',
  },
  server: {
    title: 'Installing Vulcan server',
    detail: 'Installing packaged server payload…',
  },
  etna: {
    title: 'Checking Etna',
    detail: 'Verifying Etna and required kits…',
  },
  workspace: {
    title: 'Preparing workspace runtime',
    detail: 'Checking Docker and workspace image…',
  },
  services: {
    title: 'Starting local services',
    detail: 'Starting Vulcan and waiting for health…',
  },
};

function stagePayload(key) {
  const copy = STAGE_COPY[key];
  return copy ? { type: 'stage', key, ...copy } : null;
}

function reportProgress(onProgress, payload) {
  if (!payload || typeof onProgress !== 'function') return;
  try { onProgress(payload); }
  catch { /* progress UI must never be allowed to break repair */ }
}

function installerStageForLine(line) {
  const message = String(line || '')
    .replace(/^Vulcan warning:\s*/i, '')
    .replace(/^Vulcan:\s*/i, '')
    .trim();

  const lower = message.toLowerCase();

  if (
    lower.includes('uv runtime')
    || lower.includes('vulcan-managed python')
  ) return stagePayload('python');

  if (
    lower.includes('vulcan server runtime')
    || lower.includes('vulcan linux runtime')
    || lower.includes('server payload')
    || lower.includes('converging vulcan runtime')
  ) return stagePayload('server');

  if (
    lower.includes('etna')
    || lower.includes('etna kit')
  ) return stagePayload('etna');

  if (
    lower.includes('docker')
    || lower.includes('wsl2')
    || lower.includes('colima')
    || lower.includes('workspace image')
  ) return stagePayload('workspace');

  if (
    lower.includes('starting vulcan services')
    || lower.includes('waiting for vulcan server')
    || lower.includes('server is installed and supervised')
  ) return stagePayload('services');

  return null;
}

async function probeJson(net, url, timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readSha256(filePath) {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function checkPackagedRuntime({ app, net }) {
  if (!app.isPackaged || process.env.VULCAN_SKIP_REPAIR === '1') {
    return { ok: true, needsRepair: false, skipped: true };
  }

  if (process.platform === 'darwin' && !app.isInApplicationsFolder()) {
    return { ok: true, needsRepair: true, mode: 'setup', reason: 'app-location' };
  }

  const [server, etna] = await Promise.all([
    probeJson(net, 'http://127.0.0.1:8468/meta'),
    probeJson(net, 'http://127.0.0.1:8467/health'),
  ]);

  const serverReady = server?.ok === true;
  const etnaReady = etna?.service === 'etna-mcp' && etna?.status === 'ok';

  const packagedHash = readSha256(path.join(process.resourcesPath, 'server-payload.sha256'));
  const reportedRaw = String(server?.payloadHash || '').toLowerCase();
  const reportedHash = /^[0-9a-f]{64}$/.test(reportedRaw) ? reportedRaw : null;

  // Transition fallback for Linux builds installed before /meta exposed
  // payloadHash. The converger already persists this exact desired-state hash.
  const installedLinuxHash = process.platform === 'linux'
    ? readSha256(path.join(os.homedir(), '.vulcan', 'payload', 'server-payload.sha256'))
    : null;

  const payloadCurrent = serverReady
    && Boolean(packagedHash)
    && (reportedHash === packagedHash || installedLinuxHash === packagedHash);

  if (payloadCurrent && etnaReady) {
    return { ok: true, needsRepair: false, mode: null, reason: 'healthy' };
  }

  const vulcanHomeExists = fs.existsSync(path.join(os.homedir(), '.vulcan'));
  let mode = 'repair';
  if (serverReady && !payloadCurrent) mode = 'update';
  else if (!serverReady && !vulcanHomeExists) mode = 'setup';

  return {
    ok: true,
    needsRepair: true,
    mode,
    reason: !serverReady
      ? 'server-unavailable'
      : !payloadCurrent
        ? 'server-payload'
        : 'etna-unhealthy',
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: { ...process.env, ...(options.env || {}) },
      cwd: options.cwd || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const buffers = { stdout: '', stderr: '' };

    const emitLine = (stream, line) => {
      try { options.onLine?.(stream, line); }
      catch { /* log/progress listeners are observational only */ }
    };

    const consume = (stream, chunk) => {
      const value = chunk.toString();

      if (stream === 'stdout') stdout += value;
      else stderr += value;

      buffers[stream] += value;
      const lines = buffers[stream].split(/\r?\n/);
      buffers[stream] = lines.pop() || '';

      for (const line of lines) emitLine(stream, line);
    };

    const flush = () => {
      for (const stream of ['stdout', 'stderr']) {
        if (buffers[stream]) emitLine(stream, buffers[stream]);
        buffers[stream] = '';
      }
    };

    child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      flush();
      resolve({ code: -1, stdout, stderr, error });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      flush();
      resolve({ code: Number(code ?? -1), stdout, stderr });
    });
  });
}

async function ensurePackagedRuntime({ app, dialog, shell, onProgress }) {
  if (!app.isPackaged || process.env.VULCAN_SKIP_REPAIR === '1') {
    return { ok: true, skipped: true };
  }

  reportProgress(onProgress, stagePayload('checking'));

  // macOS already ships a normal .app inside a DMG. Let Electron use the OS's
  // own Applications-folder move instead of teaching a shell script how to move
  // a live app bundle. On success Electron quits and relaunches automatically.
  if (process.platform === 'darwin' && !app.isInApplicationsFolder()) {
    try {
      if (app.moveToApplicationsFolder()) return { ok: true, relaunching: true };
    } catch (error) {
      return { ok: false, message: `Could not move Vulcan into Applications: ${error.message || error}` };
    }
  }

  const resources = process.resourcesPath;
  const version = app.getVersion();
  let command;
  let args;

  if (process.platform === 'win32') {
    command = 'powershell.exe';
    args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(resources, 'install.ps1'),
      '-FromApp', '-ResourcesDir', resources, '-Version', version, '-Json',
    ];
  } else {
    command = '/bin/bash';
    args = [
      path.join(resources, 'install.sh'),
      '--from-app', '--resources', resources, '--version', version, '--json',
    ];
    if (process.platform === 'linux') {
      args.push('--app-path', process.env.APPIMAGE || process.execPath);
    }
  }

  let sawStructuredProgress = false;

  const execution = await run(command, args, {
    onLine: (_stream, line) => {
      const clean = String(line || '').trimEnd();
      if (!clean) return;

      const progress = parseProgressLine(clean);
      if (progress) {
        sawStructuredProgress = true;
        if (progress.type === 'task' && progress.group) {
          const copy = STAGE_COPY[progress.group] || {};
          reportProgress(onProgress, {
            ...progress,
            title: copy.title,
            detail: progress.label || copy.detail,
          });
        } else {
          reportProgress(onProgress, progress);
        }
        return;
      }

      if (clean.startsWith('VULCAN_RESULT=')) return;
      reportProgress(onProgress, { type: 'log', line: clean });

      if (!sawStructuredProgress) {
        const stage = installerStageForLine(clean);
        if (stage) reportProgress(onProgress, stage);
      }
    },
  });
  const result = parseResult(execution.stdout);

  if (result?.needsHomebrew) {
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: 'Vulcan needs Homebrew',
      message: 'Vulcan uses Colima for its macOS Linux backend, and Colima is installed through Homebrew.',
      detail: 'Install Homebrew, then open Vulcan again. No Vulcan state needs to be cleaned up.',
      buttons: ['Open Homebrew', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) await shell.openExternal('https://brew.sh/');
    return { ok: false, quit: true, message: result.message || 'Homebrew is required.' };
  }

  if (result?.rebootRequired || execution.code === 20 && process.platform === 'win32') {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Restart Windows to finish Vulcan setup',
      message: result?.message || 'WSL2 was enabled and Windows needs one restart before Vulcan can continue.',
      buttons: ['OK'],
    });
    return { ok: true, quit: true, rebootRequired: true };
  }

  if (execution.code !== 0 || result?.ok === false) {
    const details = result?.message || execution.stderr.trim() || execution.stdout.trim() || `Installer exited with code ${execution.code}`;
    return { ok: false, message: details };
  }

  if (result?.needsRelogin) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Vulcan needs one new login session',
      message: 'Docker is installed and your account now has Docker access, but this desktop session has not picked up the new group yet.',
      detail: 'Log out and back in once (or reboot). Vulcan is already installed; it will repair and continue automatically when you open it again.',
      buttons: ['OK'],
    });
    return { ok: true, quit: true, needsRelogin: true };
  }

  if (!sawStructuredProgress) {
    reportProgress(onProgress, stagePayload('services'));
  }

  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }

  return { ok: true, ...result };
}

module.exports = { checkPackagedRuntime, ensurePackagedRuntime, parseResult, parseProgressLine, probeJson };
