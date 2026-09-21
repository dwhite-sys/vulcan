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
assert.equal(
  pkg.build.toolsets?.appimage,
  '1.0.2',
  'Linux AppImage must use the static runtime so host FUSE2 is not required',
);
assert.deepEqual(pkg.build.win.target, ['nsis']);
assert.deepEqual(pkg.build.mac.target, ['dmg']);
assert.equal(pkg.build.linux.desktop?.entry?.Name, 'Vulcan');
assert.equal(pkg.build.linux.desktop?.entry?.StartupWMClass, 'Vulcan');
assert.equal(
  pkg.build.linux.desktop?.entry?.['X-AppImage-Integrate'],
  'false',
  'Vulcan owns its Linux integration; AppImageLauncher must not intercept it',
);
assert.equal(pkg.build.linux.desktop?.Name, undefined, 'desktop metadata must live under linux.desktop.entry');
assert.match(pkg.scripts['electron:build'], /electron-builder --publish never/);
assert.equal(pkg.engines?.node, '>=22.12.0');
assert.equal(
  pkg.build.nsis?.runAfterFinish,
  true,
  'Windows installer must launch Vulcan after installation',
);

for (const asset of ['icon.png', 'icon.ico', 'icon.icns', 'icon-titlebar.png']) {
  assert(fs.existsSync(path.join(appRoot, 'build', asset)), `missing packaging asset: build/${asset}`);
}
const gitignore = read(path.join(root, '.gitignore'));
assert.match(gitignore, /^\/build\/$/m, 'root build output must be ignored with /build/');
assert.doesNotMatch(gitignore, /^build\/$/m, 'bare build/ would swallow vulcan-app/build icons');
assert(fs.existsSync(path.join(root, 'vulcan', 'pyproject.toml')), 'backend pyproject.toml must be at vulcan/pyproject.toml');
assert(!fs.existsSync(path.join(root, 'vulcan', 'vulcan-app')), 'backend directory must not contain a duplicate repository/vulcan-app');
assert(!fs.existsSync(path.join(root, 'vulcan', 'install.sh')), 'backend directory must not contain a duplicate repository/install.sh');
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
const setupWindow = read(path.join(appRoot, 'electron', 'setupWindow.cjs'));
const setupPreload = read(path.join(appRoot, 'electron', 'setupPreload.cjs'));
const setupHtml = read(path.join(appRoot, 'electron', 'setup.html'));
assert.match(coordinator, /process\.resourcesPath/);
assert.match(coordinator, /app\.moveToApplicationsFolder\(\)/);
assert.match(coordinator, /powershell\.exe/);
assert.match(coordinator, /install\.sh/);
assert.match(coordinator, /onProgress/);
assert.match(coordinator, /installerStageForLine/);
assert.match(coordinator, /type: 'log'/);

assert.match(main, /createSetupWindow/);
assert.match(main, /allowShow: shouldShowOnReady/);
assert.match(main, /startupRepairInProgress/);
assert.match(main, /onProgress: \(payload\) => setupController\?\.progress\(payload\)/);
assert.match(
  main,
  /await setupController\.complete\(\)[\s\S]*const passwordStore/,
  'the real Vulcan renderer must not be created until setup convergence completes',
);

assert.match(setupWindow, /width: 560, height: 124/);
assert.match(setupWindow, /width: 560, height: 390/);
assert.match(setupWindow, /SHOW_DELAY_MS = 400/);
assert.match(setupWindow, /setContentSize\(size\.width, size\.height\)/);
assert.match(setupPreload, /vulcan-setup-details/);
assert.match(setupPreload, /vulcan-setup-progress/);

assert(setupHtml.includes('Click for details'));
assert(setupHtml.includes('First launch setup'));
assert(setupHtml.includes('Working…'));
assert(setupHtml.includes('repeating-linear-gradient('));
assert(setupHtml.includes('125deg'));
assert(setupHtml.includes('rgba(255,255,255,.28) 0 7px'));
assert(setupHtml.includes('rgba(255,255,255,.05) 7px 14px'));
assert.match(setupHtml, /animation:barber \.7s linear infinite/);
assert.match(setupHtml, /from\{transform:translateX\(-20px\)\}/);
assert.match(setupHtml, /to\{transform:translateX\(0\)\}/);
assert.match(setupHtml, /--bar:#62c99d/);
assert.doesNotMatch(
  coordinator,
  /app\.relaunch/,
  'Linux first-run installation must not kill and relaunch Electron',
);
assert.doesNotMatch(
  main,
  /relaunchInstalledLinuxApp/,
  'Linux first run must continue in the launching Electron process',
);
assert.match(
  main,
  /backgroundThrottling:\s*false/,
  'tray-hidden Electron must keep renderer transport and relay work live',
);
assert.match(
  main,
  /const repair = await ensurePackagedRuntime[\s\S]*const win = createWindow\(\)/,
  'the visible application window must be created only after runtime convergence',
);

const shell = read(path.join(root, 'install.sh'));
for (const marker of ['ensure_uv()', 'ensure_python()', 'ensure_etna()', 'ensure_vulcan_runtime()', 'ensure_docker_linux()', 'ensure_vulcan_service_linux()']) {
  assert(shell.includes(marker), `missing shell repair primitive: ${marker}`);
}
assert.match(shell, /pacman -S --needed --noconfirm docker/);
assert.doesNotMatch(shell, /systemctl enable --now docker\.service/);
assert.match(shell, /Keep Etna native on macOS/);
assert.match(shell, /colima start vulcan --runtime docker/);
assert.match(shell, /VULCAN_RESULT=/);
assert.match(
  shell,
  /install_linux_desktop >\/dev\/null/,
  'Linux must persist its stable AppImage without forcing a process handoff',
);
assert.match(shell, /say "Preparing Docker workspace image"/);
assert.match(shell, /SERVICE_CHANGED/);
assert.match(shell, /standalone_linux_bootstrap\(\)/);
assert.match(shell, /releases\/latest\/download\/%s/);
assert.match(shell, /release_asset_digest\(\)/);
assert.match(shell, /digest.*sha256/i);
assert.doesNotMatch(shell, /Vulcan\.AppImage\.sha256/);
assert.doesNotMatch(shell, /--appimage-extract/);
assert.match(shell, /standalone_macos_bootstrap\(\)/);
assert.match(shell, /nohup "\$installed"/);
assert.match(shell, /open "\$target_app"/);
assert.match(shell, /--server-only/);
assert.match(shell, /standalone_server_bootstrap\(\)/);
assert.match(shell, /api\.github\.com\/repos\/dwhite-sys\/vulcan\/tarball/);
assert.doesNotMatch(shell, /Vulcan-Server\.tar\.gz/);

assert.match(shell, /SERVER_ONLY/);
assert(shell.includes('VULCAN_HOME="${VULCAN_CONFIG_DIR:-$HOME/.vulcan}"'));
assert(shell.includes('APP_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/vulcan"'));
assert(shell.includes('installed_source="$PAYLOAD_HOME/server"'));
assert.match(
  shell,
  /"\$BIN_HOME\/uv"\s+pip install[\s\\]+--python "\$RUNTIME\/bin\/python"[\s\\]+"\$installed_source"/,
);
assert(!shell.includes('"$BIN_HOME/uv" pip install --python "$RUNTIME/bin/python" "$SERVER_SOURCE"'));

const workflow = read(path.join(root, '.github', 'workflows', 'build.yml'));
assert.match(workflow, /ubuntu-latest/);
assert.match(workflow, /windows-latest/);
assert.match(workflow, /macos-latest/);
assert.match(workflow, /Vulcan\.AppImage/);
assert.match(workflow, /Vulcan-Setup\.exe/);
assert.match(workflow, /Vulcan\.dmg/);
assert.doesNotMatch(workflow, /Vulcan-Server\.tar\.gz/);
assert.doesNotMatch(workflow, /\.sha256/);
assert.match(workflow, /body_path: release-body\.md/);
assert.match(workflow, /sha256sum "artifacts\/\$asset"/);
assert.match(workflow, /headless-bootstrap-regression\.sh/);
assert.match(workflow, /softprops\/action-gh-release@v2/);
assert.match(workflow, /actions\/checkout@v6/);
assert.match(workflow, /actions\/setup-node@v7/);
assert.match(workflow, /node-version: 24/);
assert.doesNotMatch(workflow, /GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
assert.match(workflow, /if-no-files-found: error/);

const ps1 = read(path.join(root, 'install.ps1'));
assert.match(ps1, /function Start-StandaloneWindowsInstall/);
assert.match(ps1, /Vulcan-Setup\.exe/);
assert.match(ps1, /Start-Process/);
assert.match(ps1, /release\.body/);
assert.match(ps1, /\$localEtna = Join-Path \$env:USERPROFILE/);
assert.match(ps1, /Test-Path \$localEtna/);
assert.doesNotMatch(ps1, /systemctl start docker\.service vulcan\.service/);
assert.match(ps1, /function Ensure-HostEtna/);
assert.match(ps1, /visible host Chrome/);
assert.match(ps1, /\$DistroName = "Vulcan"/);
assert.match(ps1, /--import \$DistroName/);
assert.match(ps1, /systemd=true/);
assert.match(ps1, /docker\.io/);
assert.match(ps1, /-d", \$DistroName/);

const hashPath = path.join(appRoot, 'build', 'server-payload.sha256');
if (fs.existsSync(hashPath)) {
  const hash = read(hashPath).trim();
  assert.match(hash, /^[0-9a-f]{64}$/);
}

console.log('Desktop packaging, headless server install, convergent repair, tray, notification, WSL2, and Colima wiring verified.');
