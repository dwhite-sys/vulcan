import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../electron/installCoordinator.cjs', import.meta.url), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Vulcan Windows preflight '));
const hash = 'a'.repeat(64);
fs.writeFileSync(path.join(root, 'server-payload.sha256'), hash);
try {
  for (const [terminalHealthy, etnaStartup] of [[true, true], [false, true], [true, false]]) {
    let finished = 0;
    const launches = [];
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, process: { platform: 'win32', env: {}, resourcesPath: root },
      setTimeout, clearTimeout, AbortController,
      require(name) {
        if (name !== 'child_process') return require(name);
        return { spawn(command, args) {
          launches.push({ command, args });
          const child = new EventEmitter(); child.kill = () => {};
          setTimeout(() => { finished++; child.emit('close', command === 'powershell.exe' && !etnaStartup ? 1 : 0); }, 20);
          return child;
        } };
      },
    });
    const result = await module.exports.checkPackagedRuntime({
      app: { isPackaged: true },
      net: { fetch: async (url) => {
        assert.equal(finished, 5, 'HTTP health check ran before platform probes finished');
        return { ok: true, json: async () => url.endsWith('/meta')
          ? { ok: true, payloadHash: hash, terminalHost: { ok: terminalHealthy, protocol: 1 } }
          : { service: 'etna-mcp', status: 'ok' } };
      } },
    });
    assert.equal(result.needsRepair, !terminalHealthy || !etnaStartup);
    if (!terminalHealthy) assert(result.failed.includes('terminal'));
    if (!etnaStartup) assert(result.failed.includes('etna'), 'Online Etna with no login task must require repair');
    const python = launches.find(({ args }) => args.includes('-c'));
    assert(python.args.includes('/home/vulcan/.vulcan/runtime/bin/python'));
    assert.equal(python.args.at(-1), 'from vulcan import docker; raise SystemExit(0 if docker.image_current() else 1)');
    assert(launches.filter(({ command }) => command === 'wsl.exe').every(({ args }) => args.includes('--exec') && !args.includes('bash')));
    const startup = launches.find(({ command }) => command === 'powershell.exe');
    assert(startup.args.includes('-CheckEtnaStartup'));
    assert(startup.args.includes(path.join(root, 'install.ps1')));
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('Windows cold-start preflight ordering, terminal readiness, and Etna login-task verification passed.');
