import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const client = read('src/app/services/vulcan.ts');
const surface = read('src/app/components/DesignSurface.tsx');
const main = read('electron/main.cjs');
const guest = read('electron/designPreload.cjs');

assert.match(client, /export function designProxyUrl\(_chatId: string, designId: string, targetUrl\?: string\)/);
assert.match(client, /vulcan-design:\/\//);
assert.match(client, /configureDesignTransport/);
assert.match(client, /persist:vulcan-design-/);
assert.match(surface, /vulcan\.designProxyUrl\(chatId, design\.id, design\.url\)/);
assert.match(surface, /vulcan\.configureDesignTransport\(chatId, design\.id, design\.url\)/);
assert.match(surface, /setLoadedUrl\(proxyUrl\)/);
assert.match(surface, /changing the target belongs to design_update/);
assert.match(surface, /readOnly/);
assert.doesNotMatch(surface, /setLoadedUrl\(design\.url\)/);
assert.match(main, /protocol\.registerSchemesAsPrivileged/);
assert.match(main, /ses\.protocol\.handle\('vulcan-design'/);
assert.match(main, /authorization', `Bearer \$\{route\.sessionToken\}`/);
assert.match(main, /vulcan_design_root/);
assert.match(guest, /contextBridge\.executeInMainWorld/);
assert.match(guest, /class VulcanDesignWebSocket extends NativeWebSocket/);
assert.match(guest, /vulcan-design-transport-resolve/);
assert.match(guest, /vulcan_design_root/);

console.log('Design private-origin transport regression: ok');
