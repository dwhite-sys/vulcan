import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const settings = fs.readFileSync(path.join(root, 'src/app/components/SettingsDialog.tsx'), 'utf8');

for (const tabId of ['server', 'llm', 'vulcan', 'security', 'kits', 'skills']) {
  assert.match(
    settings,
    new RegExp(`activeTab\\s*===\\s*['"]${tabId}['"]`),
    `Settings tab "${tabId}" is declared but has no render branch`,
  );
}

for (const required of [
  /Trusted Harnesses/,
  /trustedHarnesses\.map/,
  /copyHarnessFingerprint/,
  /kind:\s*['"]harness['"]/,
  /ShieldCheck/,
  /ClipboardCheck/,
  /Trash2/,
]) {
  assert.match(settings, required);
}

console.log('Settings tab/render coverage regression: ok');
