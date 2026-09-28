import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileEtnaHealth } from '../src/app/services/etnaHealth.ts';

const server = (id: string, healthy: boolean) => ({
  id, name: id, url: 'http://localhost:8467', networkPointOfView: 'client' as const,
  enabled: true, healthy, inventory: [],
});

const recovered = reconcileEtnaHealth([server('a', false)], { a: true });
assert.equal(recovered.changed, true);
assert.deepEqual(recovered.recoveredServerIds, ['a']);
assert.deepEqual(recovered.offlineServerIds, []);
assert.equal(recovered.servers[0].healthy, true);

const lost = reconcileEtnaHealth([server('a', true)], { a: false });
assert.equal(lost.changed, true);
assert.deepEqual(lost.recoveredServerIds, []);
assert.deepEqual(lost.offlineServerIds, ['a']);
assert.equal(lost.servers[0].healthy, false);

const stable = reconcileEtnaHealth([server('a', true)], { a: true });
assert.equal(stable.changed, false);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'src/app/App.tsx'), 'utf8');
assert.match(app, /probeEtnaHealth\(\)/);
assert.match(app, /setInterval[\s\S]*10_000/);
assert.match(app, /recoveredServerIds\.length > 0/);
assert.match(app, /document\.visibilityState !== 'hidden'/);
assert.doesNotMatch(app, /probeEtnaHealth[\s\S]{0,500}toast\./);

console.log('etna-auto-recovery regression passed');
