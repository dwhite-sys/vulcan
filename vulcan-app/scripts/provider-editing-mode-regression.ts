import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const settings = fs.readFileSync(path.join(root, 'src/app/components/SettingsDialog.tsx'), 'utf8');

assert.match(settings, /editingProviderId \? \([\s\S]*?<span>Editing<\/span>/, 'editing mode should explicitly say Editing');
assert.match(settings, /providers\.find\(\(provider\) => provider\.id === editingProviderId\)\?\.name \|\| providerName \|\| 'Provider'/, 'editing token should show the saved provider name');
assert.match(settings, /font-mono text-\[12px\]/, 'provider name should use terminal-like monospace styling');
assert.match(settings, /\) : \(\s*<h3 className="text-sm font-medium text-ash-300">Add Provider<\/h3>/, 'new-provider mode should retain Add Provider');

const actionGroupStart = settings.indexOf('<div className="flex items-center gap-2">', settings.indexOf("<h3 className=\"text-sm font-medium text-ash-300\">Add Provider</h3>"));
const newConditional = settings.indexOf('{editingProviderId && (', actionGroupStart);
const newButton = settings.indexOf('+ New', newConditional);
const saveButton = settings.indexOf('onClick={handleSaveLLM}', newButton);
assert(actionGroupStart >= 0 && newConditional > actionGroupStart && newButton > newConditional && saveButton > newButton, '+ New should be conditional and immediately precede Save');

const providerSectionEnd = settings.indexOf('{providerSaveError', actionGroupStart);
const newOccurrences = (settings.slice(actionGroupStart, providerSectionEnd).match(/\+ New/g) ?? []).length;
assert.equal(newOccurrences, 1, 'Provider editor should have exactly one + New action');

console.log('provider editing mode regression: ok');
