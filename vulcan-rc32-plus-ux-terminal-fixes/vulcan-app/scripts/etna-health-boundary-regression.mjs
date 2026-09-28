import assert from 'node:assert/strict';
import fs from 'node:fs';

const registry = fs.readFileSync(new URL('../src/app/services/etnaRegistry.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const topbar = fs.readFileSync(new URL('../src/app/components/TopBar.tsx', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../src/app/components/SettingsDialog.tsx', import.meta.url), 'utf8');

// Health must be decided by the registry probe, before per-kit inventory work.
const discoverStart = registry.indexOf('async function discover');
const deriveStart = registry.indexOf('function logicalId', discoverStart);
const discover = registry.slice(discoverStart, deriveStart);
assert.match(discover, /listed = await request\(server, '\/list_kits'\)/);
assert.match(discover, /return \{ \.\.\.server, healthy: false \}/);
assert.match(discover, /A single broken kit should not make a reachable Etna server appear offline/);
assert.match(discover, /if \(previous\) inventory\.push\(previous\)/);
assert.match(discover, /return \{ \.\.\.server, healthy: true, inventory/);

// Derived semantic-cache failure is explicitly non-fatal to Etna connectivity.
const refreshStart = registry.indexOf('export async function refreshEtnaState');
const routeStart = registry.indexOf('export async function setEtnaRoute', refreshStart);
const refresh = registry.slice(refreshStart, routeStart);
assert.match(refresh, /try \{[\s\S]*repairToolSemanticIndex/);
assert.match(refresh, /catch \(error\)/);
assert.match(refresh, /continuing without semantic cache/);
assert.match(refresh, /return \{ \.\.\.state, semanticToolIndex \}/);

// Both status surfaces still derive from the same healthy summary/state.
assert.match(app, /setConnected\(\(state\?\.summary\?\.healthy \?\? 0\) > 0\)/);
assert.match(topbar, /connected \? 'connection-status-dot-green connection-status-dot-live'/);
assert.match(settings, /const healthy = etnaSummary\.healthy/);
assert.match(settings, /healthy === 0 \? 'connection-status-dot-gray'/);

console.log('Etna health boundary regression: ok');
