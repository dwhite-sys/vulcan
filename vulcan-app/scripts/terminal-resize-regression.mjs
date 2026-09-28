import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const widget = readFileSync(new URL('../src/app/components/TerminalSlotWidget.tsx', import.meta.url), 'utf8');

assert.match(widget, /fitAddonRef\.current\?\.fit\(\)/,
  'The visible xterm must be fit before opening/attaching the PTY');
assert.match(widget, /type: 'open'[\s\S]*cols: term\?\.cols \?\? 80[\s\S]*rows: term\?\.rows \?\? 24/,
  'The PTY open handshake must carry the fitted client geometry');
assert.match(widget, /const resizeInFlight = useRef\(false\)/,
  'Live geometry updates must be serialized');
assert.match(widget, /pendingResize[\s\S]*if \(resizeInFlight\.current\)[\s\S]*pendingResize\.current = \{ cols, rows \}/,
  'Resize bursts must coalesce to the newest geometry');
assert.match(widget, /await socket\.send\(\{ type: 'resize', cols, rows \}\)[\s\S]*const next = pendingResize\.current[\s\S]*sendResize\(next\.cols, next\.rows\)/,
  'A coalesced resize must wait for the preceding encrypted send');
assert.match(widget, /term\.onResize\(\(\{ cols, rows \}\) => \{\s*void sendResize\(cols, rows\);\s*\}\)/,
  'xterm resize events must flow through the ordered resize path');
assert.doesNotMatch(widget, /term\.onResize\(\(\{ cols, rows \}\) => \{[\s\S]{0,180}wsRef\.current\.send\(\{ type: 'resize'/,
  'xterm must not independently fire unordered PTY resize frames');

console.log('terminal resize ordering regression: ok');
