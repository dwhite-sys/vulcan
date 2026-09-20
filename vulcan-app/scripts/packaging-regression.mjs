import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const root = path.resolve(appRoot, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

const pkg = JSON.parse(read(path.join(appRoot, 'package.json')));
assert.deepEqual(pkg.build.linux.target, ['AppImage']);
assert.deepEqual(pkg.build.win.target, ['nsis']);
assert.deepEqual(pkg.build.mac.target, ['dmg']);
const extraTargets = new Set(pkg.build.extraResources.map((x) => x.to));
for (const required of ['vulcan-server', 'install.sh', 'install.ps1', 'server-payload.sha256', 'vulcan-icon.png']) {
  assert(extraTargets.has(required), `missing packaged resource: ${required}`);
}

const main = read(path.join(appRoot, 'electron', 'main.cjs'));
assert.match(main, /new Tray\(/);
assert.match(main, /event\.preventDefault\(\);\s*\n\s*win\.hide\(\)/);
assert.match(main, /vulcan-native-notify/);
assert.match(main, /note\.on\('click', \(\) => showMainWindow\(chatId\)\)/);
assert.match(main, /ensurePackagedRuntime/);

const preload = read(path.join(appRoot, 'electron', 'preload.cjs'));
assert.match(preload, /desktop:\s*\{/);
assert.match(preload, /onOpenChat/);

const coordinator = read(path.join(appRoot, 'electron', 'installCoordinator.cjs'));
assert.match(coordinator, /process\.resourcesPath/);
assert.match(coordinator, /app\.moveToApplicationsFolder\(\)/);
assert.match(coordinator, /powershell\.exe/);
assert.match(coordinator, /install\.sh/);
assert.match(coordinator, /app\.relaunch\(\{ execPath: relaunchPath, args \}\)/);

const shell = read(path.join(root, 'install.sh'));
for (const marker of ['ensure_uv()', 'ensure_python()', 'ensure_etna()', 'ensure_vulcan_runtime()', 'ensure_docker_linux()', 'ensure_vulcan_service_linux()']) {
  assert(shell.includes(marker), `missing shell repair primitive: ${marker}`);
}
assert.match(shell, /pacman -S --needed --noconfirm docker/);
assert.match(shell, /Keep Etna native on macOS/);
assert.match(shell, /colima start vulcan --runtime docker/);
assert.match(shell, /VULCAN_RESULT=/);
assert.match(shell, /standalone_linux_bootstrap\(\)/);
assert.match(shell, /releases\/latest\/download\/%s/);
assert.match(shell, /Vulcan\.AppImage\.sha256/);
assert.match(shell, /--appimage-extract/);
assert.match(shell, /--server-only/);
assert.match(shell, /standalone_server_bootstrap\(\)/);
assert.match(shell, /Vulcan-Server\.tar\.gz/);
assert.match(shell, /loginctl enable-linger/);
assert.match(shell, /SERVER_ONLY/);

const workflow = read(path.join(root, '.github', 'workflows', 'build.yml'));
assert.match(workflow, /ubuntu-latest/);
assert.match(workflow, /windows-latest/);
assert.match(workflow, /macos-latest/);
assert.match(workflow, /Vulcan\.AppImage/);
assert.match(workflow, /Vulcan-Setup\.exe/);
assert.match(workflow, /Vulcan\.dmg/);
assert.match(workflow, /Vulcan-Server\.tar\.gz/);
assert.match(workflow, /softprops\/action-gh-release@v2/);

const ps1 = read(path.join(root, 'install.ps1'));
assert.match(ps1, /function Ensure-HostEtna/);
assert.match(ps1, /visible host Chrome/);
assert.match(ps1, /\$DistroName = "Vulcan"/);
assert.match(ps1, /--import \$DistroName/);
assert.match(ps1, /systemd=true/);
assert.match(ps1, /docker\.io/);
assert.match(ps1, /-d", \$DistroName/);

const hash = read(path.join(appRoot, 'build', 'server-payload.sha256')).trim();
assert.match(hash, /^[0-9a-f]{64}$/);

console.log('Desktop packaging, headless server install, convergent repair, tray, notification, WSL2, and Colima wiring verified.');
