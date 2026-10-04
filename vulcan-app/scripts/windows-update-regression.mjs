import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../electron/updateManager.cjs', import.meta.url), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), "Vulcan update O'Neil "));
const content = Buffer.from('verified installer fixture');
const digest = crypto.createHash('sha256').update(content).digest('hex');
try {
  for (const valid of [true, false]) {
    const module = { exports: {} };
    const launches = [];
    let quitScheduled = false;
    vm.runInNewContext(source, {
      module, console, process: { platform: 'win32', pid: 123, env: {}, execPath: "C:\\Users\\O'Neil Test\\Vulcan\\Vulcan.exe" },
      URL, Response, AbortController, clearTimeout, setInterval,
      setTimeout(fn, delay) { if (delay === 350) { quitScheduled = true; return 0; } return setTimeout(fn, delay); },
      require(name) {
        if (name === 'electron') return {
          app: { isPackaged: true, getVersion: () => '1.0.0-rc.38', quit() {} },
          net: { fetch: async (url) => url.includes('api.github.com')
            ? { ok: true, json: async () => [{ tag_name: 'v1.0.0-rc.39', assets: [{ name: 'Vulcan-Setup.exe', browser_download_url: 'https://example.test/installer', digest: 'sha256:' + (valid ? digest : '0'.repeat(64)) }] }] }
            : new Response(content) },
        };
        if (name === 'os') return { tmpdir: () => root };
        if (name === 'child_process') return { spawn(command, args, options) { launches.push({ command, args, options }); return { unref() {} }; } };
        return require(name);
      },
    });
    const updater = module.exports.createUpdater({});
    assert.equal((await updater.check()).available, true);
    if (!valid) {
      await assert.rejects(updater.install(), /SHA-256/);
      assert.equal(launches.length, 0); assert.equal(quitScheduled, false);
    } else {
      assert.equal((await updater.install()).ok, true);
      assert.equal(quitScheduled, true);
      assert.equal(launches[0].command, 'powershell.exe');
      assert.equal(launches[0].options.detached, true);
      const helper = launches[0].args.at(-1);
      const text = fs.readFileSync(helper, 'utf8');
      assert.match(text, /O''Neil Test/);
      assert.match(text, /while \(Get-Process/);
      assert.match(text, /-ArgumentList '\/S' -Wait -PassThru/);
      assert.match(text, /if \(\$process.ExitCode -ne 0\)/);
      const powershell = process.env.VULCAN_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : null);
      if (powershell) {
        const parser = path.join(root, 'parse-helper.ps1');
        fs.writeFileSync(parser, 'param($Source)\n$tokens=$null; $errors=$null\n$null=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)\nif ($errors.Count) { throw ($errors | Out-String) }\n');
        await promisify(execFile)(powershell, ['-NoProfile', '-File', parser, helper]);
      }
    }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('Windows update selection, verified download, checksum rejection, detached handoff, and apostrophe/space escaping verified.');
