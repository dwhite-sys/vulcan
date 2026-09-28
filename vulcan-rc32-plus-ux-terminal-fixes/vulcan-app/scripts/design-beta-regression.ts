import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectQuotedContent } from '../src/app/services/quoteProjection.ts';
import type { MessageElementReference } from '../src/app/types/vulcan.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const app = read('src/app/App.tsx');
const chat = read('src/app/components/ChatInterface.tsx');
const design = read('src/app/components/DesignSurface.tsx');
const topbar = read('src/app/components/TopBar.tsx');
const transcriptRenderer = read('src/app/components/TranscriptRenderer.tsx');
const tools = read('src/app/services/vulcanTools.ts');
const main = read('electron/main.cjs');
const preload = read('electron/preload.cjs');
const guest = read('electron/designPreload.cjs');
const types = read('src/app/types/vulcan.ts');
const persistence = read('src/app/services/persistence.ts');

assert.match(types, /interface DesignAttachment/);
assert.match(types, /designs\?: DesignAttachment\[\]/);
assert.match(types, /updatedAt: Date/);
assert.match(persistence, /Array\.isArray\(\(c as any\)\.designs\)/);
assert.match(persistence, /item\.name \?\? item\.title/);
assert.match(app, /registerDesign/);
assert.match(app, /replaceDesigns/);
assert.match(app, /openDesignId/);
assert.match(app, /<DesignSurface/);
assert.match(app, /vulcan:element-reference/);
assert.match(app, /collapsible/);
assert.match(app, /collapsedSize=\{0\}/);
assert.doesNotMatch(chat, /data-vulcan-design-attachment/);
assert.doesNotMatch(chat, /Design · beta/);
assert.doesNotMatch(topbar, /Open Design/);
assert.doesNotMatch(topbar, /Attach Design/);
assert.match(transcriptRenderer, /data-vulcan-design-attachment/);
assert.match(transcriptRenderer, /vulcan:open-design/);
assert.match(transcriptRenderer, /event\.tool === 'open_design'/);
assert.match(app, /!sidebarCollapsed && !designOpen/);
assert.match(app, /artifactsPanelOpen && !designOpen/);
assert.match(app, /designChromeRestoreRef/);
assert.match(app, /enterDesignFocus/);
assert.match(app, /exitDesignFocus/);
assert.match(tools, /name: 'open_design'/);
assert.match(tools, /name: 'design_register'/);
assert.match(tools, /name: 'design_update'/);
assert.match(tools, /name: 'design_info'/);
assert.match(tools, /name: 'design_list'/);
assert.match(tools, /name: 'design_remove'/);
assert.match(tools, /precision frontend-development surface/);
assert.match(tools, /transition into live-surface control/);
assert.match(tools, /discoverable through search_tools/);
assert.match(tools, /ctx\.designRegister\(name, url\)/);
assert.match(tools, /ctx\.openDesign\(name\)/);
assert.match(main, /webviewTag: true/);
assert.match(design, /vulcan-design-select-mode/);
assert.match(design, /vulcan-design-element/);
assert.match(design, /Escape/);
assert.match(guest, /getByRole/);
assert.match(guest, /getByTestId/);
assert.match(guest, /hierarchyAddress/);
assert.match(guest, /filteredAttributes/);

assert.doesNotMatch(preload, /require\(['"]path['"]\)/, 'BrowserWindow preload must remain compatible with Electron sandboxed preload APIs');
assert.doesNotMatch(preload, /designPreloadUrl/, 'Guest preload path belongs to the Electron main process, not the renderer bridge');
assert.match(main, /webPreferences\.preload = path\.join\(__dirname, 'designPreload\.cjs'\)/, 'Electron main must force the Design guest preload');
assert.match(design, /desktopDesignAvailable/, 'DesignSurface should detect the Electron Design transport bridge');
assert.doesNotMatch(design, /preload=\{preloadUrl\}/, 'DesignSurface should not receive or control the guest preload filesystem path');
assert.match(tools, /register the server-local URL/, 'Design registration guidance should tell agents to use server-local workspace URLs');

const element: MessageElementReference = {
  id: 'element-1',
  designId: 'design-1',
  locator: "getByRole('button', { name: 'Save changes' })",
  hierarchyAddress: 'main.settings > section.profile > footer.actions > button',
  tagName: 'button',
  text: 'Save changes',
  url: 'http://localhost:5173/settings',
  route: '/settings',
  attributes: { 'aria-label': 'Save changes', type: 'button' },
};
const projected = projectQuotedContent('Change \uE000vulcan-element:element-1\uE001.', [], [], ['element-1'], [element]);
assert.match(projected, /<element id="1"/);
assert.match(projected, /locator="getByRole/);
assert.match(projected, /route="\/settings"/);

console.log('Design beta regression: ok');
