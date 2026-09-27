import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const persistence = read('src/app/services/persistence.ts');
const profiles = read('src/app/services/serverProfiles.ts');
const etna = read('src/app/services/etnaRegistry.ts');
const trust = read('src/app/services/harnessTrust.ts');
const passwordStore = read('electron/securePasswordStore.cjs');
const app = read('src/app/App.tsx');

// Client-global state: connection bookmarks/current endpoint and UI/agent preferences.
assert.doesNotMatch(persistence, /settings\.discoveryExecution\s*=\s*['"]search-inspect['"];/,
  'saved discovery execution mode must not be overwritten on load');
assert.match(profiles, /vulcan:server_profiles/);
assert.match(profiles, /vulcan:endpoint/);
assert.match(persistence, /settings:\s+'vulcan:settings'/);
assert.match(persistence, /toolMode:\s*'search'/,
  'fresh installs must default Tool Mode to SEARCH');
assert.match(persistence, /discoveryExecution:\s*'search-inspect'/,
  'fresh installs must default Discovery Execution to SEARCH');
assert.match(read('src/app/services/vulcanTools.ts'), /toolMode:\s*'broad' \| 'search' = 'search'/,
  'tool construction fallback must match the persisted SEARCH default');
assert.match(read('src/app/services/vulcanTools.ts'), /discoveryExecution:\s*'wrapper' \| 'promotion' \| 'search-inspect' = 'search-inspect'/,
  'tool construction discovery fallback must match SEARCH execution');

// Client-owned, per-Vulcan-server profiles/selections.
for (const expr of [
  /scopedNetworkKey\(PROVIDERS_KEY\)/,
  /scopedNetworkKey\(KEYS\.llmConfig\)/,
  /scopedNetworkKey\(KEYS\.selectedModel\)/,
  /scopedNetworkKey\(DISABLED_ETNA_SKILLS_KEY\)/,
]) assert.match(persistence, expr);
assert.match(etna, /scopedNetworkKey\(SERVERS_KEY\)/);
assert.match(etna, /scopedNetworkKey\(ROUTES_KEY\)/);

// Kit/tool defaults are client-owned and keyed by active Vulcan endpoint.
assert.match(app, /saveDefaultEnabledKits\(activeVulcanEndpoint,/);
assert.match(app, /saveDefaultDisabledTools\(activeVulcanEndpoint,/);

// Etna general-skill enablement must survive refresh/restart and remain server-scoped.
assert.match(app, /!loadDisabledEtnaSkills\(\)\.has\(skill\.name\)/);
assert.match(app, /saveDisabledEtnaSkills\(disabled\)/);

// Server passwords never enter profiles/localStorage; Electron persistence is OS-encrypted.
assert.doesNotMatch(profiles, /password\s*:/);
assert.match(passwordStore, /safeStorage/);
assert.match(passwordStore, /encryptString/);
assert.match(passwordStore, /serialize\(async \(\) =>/);

// Harness pins are client-owned by normalized endpoint and verified after persistence.
assert.match(trust, /localStorage\.setItem\(pinKey, encoded\)/);
assert.match(trust, /localStorage\.getItem\(pinKey\) !== encoded/);

// Conversations are server-owned: no localStorage chat fallback.
assert.match(persistence, /All chat persistence goes through the Vulcan server/);
assert.doesNotMatch(persistence, /localStorage\.(?:getItem|setItem)\([^)]*chat/i);

console.log('Settings persistence ownership/scope regression: ok');
