import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');

const sourcePath = path.join(appDir, 'electron', 'updateManager.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');

const sandboxModule = { exports: {} };
let periodicCheck;
let periodicInterval;
let discoveryRequests = 0;
const electronMock = {
  app: { getVersion: () => '1.0.0-rc.16', isPackaged: true },
  net: { fetch: async () => {
    discoveryRequests++;
    return { ok: true, json: async () => [{ tag_name: 'v1.0.0rc17', assets: [{
      name: 'Vulcan.AppImage', browser_download_url: 'https://example.test/Vulcan.AppImage',
      digest: `sha256:${'a'.repeat(64)}`,
    }] }] };
  } },
};
const mockRequire = (name) => {
  if (name === 'electron') return electronMock;
  return requireBuiltin(name);
};
const requireBuiltin = (name) => {
  if (name === 'path') return path;
  if (name === 'fs') return fs;
  if (name === 'os') return { tmpdir: () => '/tmp', homedir: () => '/home/test' };
  if (name === 'crypto') return {};
  if (name === 'child_process') return {};
  if (name === 'stream') return { Readable: {} };
  if (name === 'events') return { once: async () => {} };
  throw new Error(`Unexpected require: ${name}`);
};

vm.runInNewContext(source, {
  module: sandboxModule,
  exports: sandboxModule.exports,
  require: mockRequire,
  console,
  process: { platform: 'linux', pid: 123, env: {}, execPath: '/tmp/Vulcan' },
  setTimeout,
  clearTimeout,
  setInterval: (callback, interval) => {
    periodicCheck = callback;
    periodicInterval = interval;
    return { unref() {} };
  },
  URL,
  Response,
  AbortController,
}, { filename: sourcePath });

const { parseVersion, compareVersions, displayVersion, shaFromRelease } = sandboxModule.exports;

const rc16 = parseVersion('1.0.0-rc.16');
const rc17 = parseVersion('v1.0.0rc17');
const stable = parseVersion('v1.0.0');
assert.ok(rc16);
assert.ok(rc17);
assert.ok(stable);
assert.equal(displayVersion(rc16), 'v1.0.0rc16');
assert.equal(displayVersion(rc17), 'v1.0.0rc17');
assert.equal(compareVersions(rc17, rc16), 1);
assert.equal(compareVersions(stable, rc17), 1);
assert.equal(compareVersions(rc16, stable), -1);

const hash = 'a'.repeat(64);
assert.equal(
  shaFromRelease(
    { body: `### SHA-256\n\n| Asset | SHA-256 |\n| --- | --- |\n| \`Vulcan.AppImage\` | \`${hash}\` |\n` },
    { name: 'Vulcan.AppImage' },
  ),
  hash,
);
assert.equal(
  shaFromRelease({}, { name: 'Vulcan.AppImage', digest: `sha256:${hash}` }),
  hash,
);

const windowActions = [];
const states = [];
const updater = sandboxModule.exports.createUpdater({
  getMainWindow: () => ({
    isDestroyed: () => false, isMinimized: () => true,
    restore: () => windowActions.push('restore'),
    show: () => windowActions.push('show'),
    focus: () => windowActions.push('focus'),
    webContents: { send: (channel, state) => windowActions.push({ channel, state }) },
  }),
  onStateChanged: state => states.push(state),
});
assert.equal((await updater.check({ startup: true })).promptOnStartup, true);
assert.equal(states.at(-1).available, true);
windowActions.length = 0;
updater.startPeriodicChecks();
assert.equal(periodicInterval, 60 * 60 * 1000);
updater.startPeriodicChecks();
periodicCheck();
await updater.check(); // joins the periodic request
assert.equal(states.at(-1).promptOnStartup, false);
assert.equal(windowActions.length, 1);
assert.equal(windowActions[0].channel, 'vulcan-update-state');
windowActions.length = 0;
const requestsBeforeOpen = discoveryRequests;
updater.openPrompt();
assert.deepEqual(windowActions.slice(0, 3), ['restore', 'show', 'focus']);
assert.equal(windowActions[3].channel, 'vulcan-update-open');
assert.equal(windowActions[3].state.tag, 'v1.0.0rc17');
assert.equal(discoveryRequests, requestsBeforeOpen, 'Opening the prompt must not start a download');

const main = fs.readFileSync(path.join(appDir, 'electron', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(appDir, 'electron', 'preload.cjs'), 'utf8');
const app = fs.readFileSync(path.join(appDir, 'src', 'app', 'App.tsx'), 'utf8');
const prompt = fs.readFileSync(path.join(appDir, 'src', 'app', 'components', 'UpdatePrompt.tsx'), 'utf8');

assert.match(main, /label: 'Update'/);
assert.match(main, /vulcan-update-install/);
assert.match(main, /updater\.startPeriodicChecks\(\)/);
assert.match(main, /updater\?\.check\?\.\(\{ startup: true \}\)/);
assert.match(main, /label: 'Update',\s*click: \(\) => updater\?\.openPrompt\?\.\(\)/);
assert.match(preload, /updates:\s*\{/);
assert.match(preload, /vulcan-update-open/);
assert.match(app, /<UpdatePrompt \/>/);
assert.match(prompt, /Would you like to update and restart now\?/);
assert.match(prompt, /Update and Restart/);

console.log('Vulcan updater regression: OK');
