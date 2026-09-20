import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lifecycle = readFileSync(new URL('../src/app/services/connectionLifecycle.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const ws = readFileSync(new URL('../src/app/services/ws.ts', import.meta.url), 'utf8');

assert.match(lifecycle, /PLATFORM TOPOLOGY[\s\S]*Electron desktop[\s\S]*Capacitor \/ Android[\s\S]*Plain web app/,
  'The three-platform lifecycle topology must remain documented next to the adapter');
assert.match(main, /powerMonitor\.on\('resume'/,
  'Electron OS resume must proactively mark the connection suspect');
assert.match(preload, /onConnectionMayBeStale/,
  'Electron preload must expose only the semantic lifecycle hint');
assert.match(lifecycle, /appStateChange[\s\S]*isActive/,
  'Capacitor foregrounding must proactively verify the connection');
assert.match(lifecycle, /visibilitychange[\s\S]*pageshow[\s\S]*TIMER_GAP_MS/,
  'Web lifecycle must use visibility/pageshow plus timer discontinuity fallback');
assert.match(lifecycle, /ensureConnected\(\{ reconfirm: true \}\)/,
  'All lifecycle paths must converge on the same reconfirmation routine');
assert.match(ws, /if \(this\.recoveryPromise && this\.recoveryGeneration === generation\) return this\.recoveryPromise/,
  'Concurrent authenticated work must debounce/queue behind one recovery promise');
assert.match(ws, /client\/proof-of-life/,
  'Reconfirmation must use the encrypted General WS proof-of-life route');

console.log('Electron, Capacitor/Android, and web lifecycle hints converge on one idempotent General WS recovery barrier.');
