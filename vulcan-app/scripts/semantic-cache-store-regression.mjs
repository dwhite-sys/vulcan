import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSemanticToolCacheStore } = require('../electron/semanticToolCacheStore.cjs');
const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vulcan-semantic-cache-'));
try {
  const store = createSemanticToolCacheStore({ userDataPath });
  const endpoint = 'http://server.example:8468/';
  await Promise.all(Array.from({ length: 32 }, (_, index) => store.write(endpoint, {
    schemaVersion: 1, endpoint: endpoint.replace(/\/$/, ''), model: 'fixture', dimensions: 2,
    catalogHash: String(index), updatedAt: new Date().toISOString(), entries: {},
  })));
  const final = await store.read(endpoint);
  assert.ok(final && typeof final.catalogHash === 'string');
  assert.equal(fs.readdirSync(store.directory).filter((name) => name.endsWith('.tmp')).length, 0);

  const cacheFile = fs.readdirSync(store.directory).find((name) => name.endsWith('.json'));
  assert.ok(cacheFile);
  fs.writeFileSync(path.join(store.directory, cacheFile), '{truncated', 'utf8');
  assert.equal(await store.read(endpoint), null);
  assert.ok(fs.readdirSync(store.directory).some((name) => name.includes('.corrupt-')));
  console.log('Atomic/corrupt semantic cache store regression: ok');
} finally {
  fs.rmSync(userDataPath, { recursive: true, force: true });
}
