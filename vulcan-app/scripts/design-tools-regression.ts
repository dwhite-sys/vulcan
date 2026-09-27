import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const tools = read('src/app/services/vulcanTools.ts');
const app = read('src/app/App.tsx');
const persistence = read('src/app/services/persistence.ts');
const workspace = read('src/app/components/WorkspacePanel.tsx');
const transcript = read('src/app/components/TranscriptRenderer.tsx');
const topbar = read('src/app/components/TopBar.tsx');
const types = read('src/app/types/vulcan.ts');

for (const name of ['design_register', 'design_update', 'design_info', 'design_list', 'design_remove', 'open_design']) {
  assert.match(tools, new RegExp(`name: '${name}'`), `${name} must be model-visible`);
}
assert.match(tools, /does not create or start the app/);
assert.match(tools, /does not inspect the live page/);
assert.match(tools, /does not stop the app or delete its files/);
assert.match(tools, /precision frontend-development surface/);
assert.match(tools, /building or editing web-rendered applications/);
assert.match(tools, /Electron-style renderers/);
assert.match(tools, /proposed interface or frontend work that is still being defined/);
assert.match(tools, /concrete interpretation would help clarify the target/);
assert.match(tools, /prefer preview/);
assert.match(tools, /transition into live-surface control/);
assert.match(tools, /discoverable through search_tools/);
assert.match(tools, /call open_design afterward to bind the live surface to the updated URL/);
assert.doesNotMatch(tools, /open_design requires url/);

assert.match(types, /designs\?: DesignAttachment\[\]/);
assert.match(types, /name: string;/);
assert.match(persistence, /Array\.isArray\(\(c as any\)\.designs\)/);
assert.match(persistence, /item\.name \?\? item\.title \?\? 'Design'/);

assert.match(app, /designsByChatRef/);
assert.match(app, /design_already_exists/);
assert.match(app, /const updated: DesignAttachment = \{ \.\.\.existing, url, updatedAt: new Date\(\) \}/);
assert.match(app, /enterDesignFocus\(design\.id\)/);
assert.match(app, /designRegister: \(name, url\) => registerDesign/);
assert.match(app, /openDesign: \(name\) => showDesign/);
assert.match(workspace, /Designs/);
assert.match(workspace, /onOpenDesign\(design\.name\)/);
assert.match(transcript, /vulcan:open-design/);
assert.match(transcript, /data-vulcan-design-attachment/);
assert.doesNotMatch(topbar, /Open Design/);

console.log('Design registry tools regression: ok');
