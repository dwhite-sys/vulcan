const { spawn } = require('child_process');
const path = require('path');

function parseResult(output) {
  const lines = String(output || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.startsWith('VULCAN_RESULT=')) continue;
    try { return JSON.parse(line.slice('VULCAN_RESULT='.length)); }
    catch { return null; }
  }
  return null;
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
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr, error }));
    child.on('close', (code) => resolve({ code: Number(code ?? -1), stdout, stderr }));
  });
}

async function ensurePackagedRuntime({ app, dialog, shell }) {
  if (!app.isPackaged || process.env.VULCAN_SKIP_REPAIR === '1') {
    return { ok: true, skipped: true };
  }

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

  const execution = await run(command, args);
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

  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }

  return { ok: true, ...result };
}

function relaunchInstalledLinuxApp({ app, relaunchPath }) {
  if (process.platform !== 'linux' || !relaunchPath) return false;
  const args = process.argv.includes('--hidden') ? ['--hidden'] : [];
  // app.relaunch schedules the installed AppImage after this process exits,
  // avoiding a race with Electron's single-instance lock.
  app.relaunch({ execPath: relaunchPath, args });
  app.exit(0);
  return true;
}

module.exports = { ensurePackagedRuntime, relaunchInstalledLinuxApp, parseResult };
