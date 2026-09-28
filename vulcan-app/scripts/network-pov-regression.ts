import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const settings = fs.readFileSync(path.join(root, 'src/app/components/SettingsDialog.tsx'), 'utf8');
const persistence = fs.readFileSync(path.join(root, 'src/app/services/persistence.ts'), 'utf8');
const llm = fs.readFileSync(path.join(root, 'src/app/services/llm.ts'), 'utf8');
const wsGeneral = fs.readFileSync(path.resolve(root, '../vulcan/ws_general.py'), 'utf8');

assert.match(llm, /networkPointOfView: 'client' \| 'server';/);
assert.doesNotMatch(persistence, /networkPointOfView: 'client' \| 'server';/, 'POV must not be a global Vulcan setting');
assert.match(persistence, /networkPointOfView: provider\.networkPointOfView === 'server' \? 'server' : 'client'/);
assert.match(wsGeneral, /pov = "server" if \(supplied\.get\("networkPointOfView"\)/);
assert.match(wsGeneral, /"networkPointOfView": pov/);
assert.match(wsGeneral, /"clientId": self\.client_device_id if pov == "client" else None/);

assert.match(settings, /const \[providerNetworkPointOfView, setProviderNetworkPointOfView\] = useState<'client' \| 'server'>\('client'\);/);
assert.match(settings, /networkPointOfView: providerNetworkPointOfView/);
assert.match(settings, /setProviderNetworkPointOfView\(provider\.networkPointOfView === 'server' \? 'server' : 'client'\)/);
assert.match(settings, /setProviderNetworkPointOfView\('client'\)/);

assert.match(settings, /title="Change from which point of view the networking works"/);
assert.match(settings, /const nextValue = value === 'client' \? 'server' : 'client';/);
assert.match(settings, /onClick=\{\(\) => onChange\(nextValue\)\}/);
assert.match(settings, /rounded-full px-2 py-0\.5 text-\[9px\] font-semibold tracking-wide/);

const uses = settings.match(/<NetworkPointOfViewToggle/g) ?? [];
assert.equal(uses.length, 2, 'POV toggle should appear in Provider and Etna endpoint editors only');

const providerUrl = settings.indexOf('placeholder="http://localhost:11434/v1"');
const providerToggle = settings.indexOf('<NetworkPointOfViewToggle', providerUrl);
const providerDot = settings.indexOf('connection-status-dot', providerToggle);
assert(providerUrl >= 0 && providerToggle > providerUrl && providerDot > providerToggle, 'Provider POV toggle should sit inside the URL field immediately before its status dot');
assert.match(settings, /className="w-full bg-ash-800 border border-ash-700 rounded-md pl-3 pr-36 py-2/);
assert.match(settings, /className="absolute inset-y-0 right-7 flex items-center"/);

const etnaEditor = settings.indexOf('Server Name');
const etnaToggle = settings.indexOf('<NetworkPointOfViewToggle', etnaEditor);
assert(etnaToggle > etnaEditor, 'Etna server editor should expose per-entry networking POV');

const vulcanHeader = settings.indexOf("editingVulcanServerId ? 'Edit Server' : 'Add Server'");
const nextToggleAfterVulcan = settings.indexOf('<NetworkPointOfViewToggle', vulcanHeader);
assert.equal(nextToggleAfterVulcan, -1, 'Vulcan server editor must not expose a networking POV toggle');

assert.match(settings, /border-coral-400\/30 bg-coral-500\/10 px-2 py-0\.5 text-\[9px\] font-semibold tracking-wide text-coral-400/);
assert.match(settings, /\{\(provider\.networkPointOfView === 'server' \? 'SERVER' : 'CLIENT'\)\}/);

console.log('network POV regression: ok');
