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
const electronMock = {
  app: { getVersion: () => '1.0.0-rc.16', isPackaged: true },
  net: {},
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
  setInterval,
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

const main = fs.readFileSync(path.join(appDir, 'electron', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(appDir, 'electron', 'preload.cjs'), 'utf8');
const app = fs.readFileSync(path.join(appDir, 'src', 'app', 'App.tsx'), 'utf8');
const prompt = fs.readFileSync(path.join(appDir, 'src', 'app', 'components', 'UpdatePrompt.tsx'), 'utf8');

assert.match(main, /label: 'Update and Restart'/);
assert.match(main, /vulcan-update-install/);
assert.match(main, /updater\.startPeriodicChecks\(\)/);
assert.match(preload, /updates:\s*\{/);
assert.match(preload, /vulcan-update-open/);
assert.match(app, /<UpdatePrompt \/>/);
assert.match(prompt, /Would you like to update and restart now\?/);
assert.match(prompt, /Update and Restart/);

console.log('Vulcan updater regression: OK');
