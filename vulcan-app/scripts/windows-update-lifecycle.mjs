import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const source = fs.readFileSync(new URL('../electron/updateManager.cjs', import.meta.url), 'utf8');
if (process.platform !== 'win32') {
  console.log('Windows updater lifecycle: skipped on non-Windows');
} else if (process.argv[2] === '--parent') {
  const root = process.argv[3];
  const fixture = path.join(root, 'fixture.exe');
  const content = fs.readFileSync(fixture);
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  const mockedModule = { exports: {} };
  vm.runInNewContext(source, {
    module: mockedModule, console,
    process: {platform:'win32', pid:process.pid, env:process.env, execPath:fixture},
    setTimeout, clearTimeout, setInterval, AbortController, Response,
    require(name) {
      if (name === 'os') return {tmpdir:()=>root};
      if (name === 'electron') return {
        app:{isPackaged:true, getVersion:()=> '1.0.0-rc.42', getPath:()=>root, quit:()=>process.exit(0)},
        net:{fetch:async(url)=>url.includes('api.github.com')
          ? {ok:true, json:async()=>[{tag_name:'v1.0.0rc45',assets:[{name:'Vulcan-Setup.exe',browser_download_url:'https://fixture/installer',digest:'sha256:'+digest}]}]}
          : new Response(content)},
      };
      return require(name);
    },
  });
  const updater = mockedModule.exports.createUpdater({});
  await updater.check();
  await updater.install();
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Vulcan lifecycle O'Neil "));
  const q = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    const build = path.join(root, 'build.ps1');
    fs.writeFileSync(build, `$code = @'\nusing System; using System.IO;\npublic class Fixture { public static int Main(string[] args) { File.AppendAllText(Environment.GetEnvironmentVariable("VULCAN_UPDATE_TEST_MARKER"), args.Length > 0 ? "installer\\n" : "relaunch\\n"); return args.Length > 0 && Environment.GetEnvironmentVariable("VULCAN_UPDATE_TEST_FAIL") == "1" ? 7 : 0; } }\n'@\nAdd-Type -TypeDefinition $code -OutputAssembly ${q(path.join(root,'fixture.exe'))} -OutputType ConsoleApplication\n`);
    await exec('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',build]);
    for (const fail of [false, true]) {
      const marker = path.join(root, fail ? 'failed.txt' : 'success.txt');
      await exec(process.execPath, [fileURLToPath(import.meta.url),'--parent',root], {
        env:{...process.env,VULCAN_UPDATE_TEST_MARKER:marker,VULCAN_UPDATE_TEST_FAIL:fail?'1':'0'}, timeout:30_000,
      });
      const deadline = Date.now()+20_000;
      const log = path.join(root,'update.log');
      while (true) {
        const calls = fs.existsSync(marker) ? fs.readFileSync(marker,'utf8') : '';
        const text = fs.existsSync(log) ? fs.readFileSync(log,'utf8') : '';
        if (fail ? text.includes('installer exited with code 7') : calls.includes('relaunch')) {
          assert.equal(calls, fail ? 'installer\n' : 'installer\nrelaunch\n');
          break;
        }
        assert.ok(Date.now()<deadline, 'Helper did not finish after parent exited');
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    console.log('Windows native updater: parent exit, installer success, relaunch, and logged installer failure verified.');
  } finally {
    // Allow the independent helper to finish closing its transcript.
    await new Promise(resolve=>setTimeout(resolve,500));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
