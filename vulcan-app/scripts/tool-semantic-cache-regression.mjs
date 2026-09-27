import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cache = fs.readFileSync(path.join(root, 'src/app/services/toolSemanticCache.ts'), 'utf8');
const etna = fs.readFileSync(path.join(root, 'src/app/services/etnaRegistry.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app/App.tsx'), 'utf8');
const runtime = fs.readFileSync(path.join(root, '../vulcan/vulcan/agent_runtime.py'), 'utf8');
const ws = fs.readFileSync(path.join(root, '../vulcan/vulcan/ws_general.py'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
const store = fs.readFileSync(path.join(root, 'electron/semanticToolCacheStore.cjs'), 'utf8');

// Client owns persistent corpus vectors and refreshes by document hash.
assert.match(cache, /crypto\.subtle\.digest\('SHA-256'/);
assert.match(cache, /cached\?\.document === document/);
assert.match(cache, /for \(let offset = 0; offset < missing\.length/);
assert.match(cache, /Removed[\s\S]*next atomic write prunes them/);
assert.match(cache, /electronAPI\?\.semanticToolCache/);
assert.match(store, /await handle\.sync\(\)/);
assert.match(store, /await fsp\.rename\(tmp, filename\)/);
assert.match(store, /corrupt-/);
assert.match(main, /registerSemanticToolCacheIpc/);

// Every discovery/refresh/route change repairs the current cache. Run start
// kicks repair in the background so provider dispatch is never held behind it.
assert.match(etna, /repairToolSemanticIndex\(resolved, true\)/);
assert.match(app, /void repairToolSemanticIndex\(kitsWithTools\)\.then/);
assert.match(app, /toolSemanticIndex,/);

// The server is only the embedding service + runtime ranker: search_tools itself
// must never batch-embed missing corpus documents anymore.
assert.match(ws, /"semantic\/embed"/);
assert.match(runtime, /client-owned and supplied per run/);
assert.doesNotMatch(runtime, /_TOOL_EMBEDDING_CACHE/);
assert.doesNotMatch(runtime, /encoder\.embed\(missing\)/);
assert.match(runtime, /recall\.embedder\(\)\.embed\(\[query\]\)/);

// Selected duplicate routes expose the selected source's tool schema, ensuring
// a schema/description change produces a new semantic document hash.
assert.match(etna, /const effectiveKit = effective/);

console.log('Client-owned semantic tool cache and delta-repair regression: ok');

