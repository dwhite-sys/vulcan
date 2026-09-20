import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
let source = fs.readFileSync(path.join(root, 'src/app/services/networkProfileScope.ts'), 'utf8')
  .replace(/export /g, '')
  .replace(/: string \| null/g, '')
  .replace(/: string/g, '');

const store = new Map();
const localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k,v) => store.set(k,String(v)),
  removeItem: k => store.delete(k),
};
const context = { localStorage, URL, encodeURIComponent };
vm.createContext(context);
vm.runInContext(source + '\nthis.api={activeVulcanProfileScope,scopedNetworkKey,migrateScopedNetworkValue};', context);
const { scopedNetworkKey, migrateScopedNetworkValue } = context.api;

const endpoint = url => localStorage.setItem('vulcan:endpoint', JSON.stringify(url));
endpoint('http://server-x:8468');
const xKey = scopedNetworkKey('vulcan:providers');
localStorage.setItem(xKey, JSON.stringify([{name:'X'}]));
endpoint('http://server-y:8468');
const yKey = scopedNetworkKey('vulcan:providers');
assert.notEqual(xKey, yKey);
assert.equal(localStorage.getItem(yKey), null);
localStorage.setItem(yKey, JSON.stringify([{name:'Y'}]));
endpoint('http://server-x:8468');
assert.deepEqual(JSON.parse(localStorage.getItem(scopedNetworkKey('vulcan:providers'))), [{name:'X'}]);
endpoint('http://server-y:8468');
assert.deepEqual(JSON.parse(localStorage.getItem(scopedNetworkKey('vulcan:providers'))), [{name:'Y'}]);

// Legacy global state migrates exactly once into the currently selected server.
localStorage.setItem('vulcan:etna_servers', '[{"name":"legacy"}]');
const migrated = migrateScopedNetworkValue('vulcan:etna_servers');
assert.equal(migrated, '[{"name":"legacy"}]');
assert.equal(localStorage.getItem('vulcan:etna_servers'), null);
endpoint('http://server-z:8468');
assert.equal(migrateScopedNetworkValue('vulcan:etna_servers'), null);

const persistence = fs.readFileSync(path.join(root, 'src/app/services/persistence.ts'), 'utf8');
const etnaRegistry = fs.readFileSync(path.join(root, 'src/app/services/etnaRegistry.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app/App.tsx'), 'utf8');
assert.match(persistence, /scopedNetworkKey\(KEYS\.llmConfig\)/);
assert.match(persistence, /scopedNetworkKey\(KEYS\.selectedModel\)/);
assert.match(etnaRegistry, /scopedNetworkKey\(ROUTES_KEY\)/);
assert.match(app, /setEtnaServers\(loadEtnaServers\(\)\)[\s\S]*refreshEtnaState\(\)\.then\(applyEtnaState\)/);
assert.match(app, /loadDefaultEnabledKits\(activeVulcanEndpoint\)/);
assert.doesNotMatch(app, /loadServerUrl|saveServerUrl|const \[serverUrl/);

console.log('Per-Vulcan-server client network profile scope regression: ok');
