import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Vulcan repair test '));
const source = fs.readFileSync(new URL('../electron/installCoordinator.cjs', import.meta.url), 'utf8');
const runs = [
  { code: 1, stdout: 'WSL error 0x80370102\nVULCAN_RESULT={"ok":false,"message":"WSL import failed: 0x80370102"}\n', stderr: 'WARNING: Scripts directory is not on PATH\n' },
  { code: 20, stdout: 'VULCAN_RESULT={"ok":true,"rebootRequired":true}\n', stderr: '' },
  { code: 0, stdout: 'VULCAN_RESULT={"ok":true}\n', stderr: '' },
];
try {
  for (const run of runs) {
    const exports = { exports: {} };
    let launch;
    let loginEnabled = false;
    let rebootDialog = false;
    const context = {
      module: exports, process: { platform: 'win32', env: {}, resourcesPath: 'C:\\Users\\Test User\\Vulcan\\resources' },
      setTimeout, clearTimeout, AbortController,
      require(name) {
        if (name !== 'child_process') return require(name);
        return { spawn(command, args) {
          launch = { command, args };
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from(run.stdout));
            child.stderr.emit('data', Buffer.from(run.stderr));
            child.emit('close', run.code);
          });
          return child;
        } };
      },
    };
    vm.runInNewContext(source, context);
    const result = await exports.exports.ensurePackagedRuntime({
      app: { isPackaged: true, getVersion: () => 'test', getPath: () => root, setLoginItemSettings: () => { loginEnabled = true; } },
      dialog: { showMessageBox: async () => { rebootDialog = true; return { response: 0 }; } }, shell: {},
    });
    assert.equal(launch.command, 'powershell.exe');
    assert(launch.args.includes(context.process.resourcesPath), 'Resources path must be a single argument');
    if (run.code === 1) {
      assert.equal(result.ok, false);
      assert.match(result.message, /WSL import failed: 0x80370102/);
      assert.doesNotMatch(result.message, /WARNING/);
      assert.match(result.message, /repair.log/);
      const log = fs.readFileSync(path.join(root, 'repair.log'), 'utf8');
      assert.match(log, /0x80370102/); assert.match(log, /WARNING/);
      assert.equal(loginEnabled, false);
    } else if (run.code === 20) {
      assert.equal(result.rebootRequired, true); assert.equal(result.quit, true);
      assert.equal(rebootDialog, true); assert.equal(loginEnabled, false);
    } else { assert.equal(result.ok, true); assert.equal(loginEnabled, true); }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('Windows repair error selection, logs, spaced resource paths, reboot handling, and successful integration verified.');
