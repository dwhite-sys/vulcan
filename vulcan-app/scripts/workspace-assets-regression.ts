import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  projectWorkspaceAssets,
  reconcileDashboardInventory,
  workspaceAssetRevision,
} from '../src/app/services/workspaceAssets.ts';
import { rehydrateChatEvents } from '../src/app/services/transcript.ts';
import type { ChatEvent } from '../src/app/types/vulcan.ts';

const at = (offset: number) => new Date(1_700_000_000_000 + offset);
const events: ChatEvent[] = [
  { id: 'user', type: 'user_message', content: 'Build DOOM', timestamp: at(0), runId: 'run' },
  { id: 'dashboard-created', type: 'panel', panel: { name: 'doom', updatedAt: at(1), messageId: 'create-call' }, timestamp: at(1), runId: 'run' },
  { id: 'file-created', type: 'presented_file', file: { path: 'doom/readme.md', name: 'readme.md', presentedAt: at(2), messageId: 'present-1' }, timestamp: at(2), runId: 'run' },
  { id: 'dashboard-updated', type: 'panel', panel: { name: 'doom', updatedAt: at(3), messageId: 'update-call' }, timestamp: at(3), runId: 'run' },
  { id: 'file-updated', type: 'presented_file', file: { path: 'doom/readme.md', name: 'updated-readme.md', presentedAt: at(4), messageId: 'present-2' }, timestamp: at(4), runId: 'run' },
  { id: 'text', type: 'assistant_text', content: 'The dashboard is live.', status: 'complete', timestamp: at(5), runId: 'run' },
];

const projected = projectWorkspaceAssets(events);
assert.equal(projected.presentedFiles.length, 1);
assert.equal(projected.presentedFiles[0].name, 'updated-readme.md');
assert.equal(projected.panels.length, 1);
assert.equal(projected.panels[0].messageId, 'update-call');

const authoritative = reconcileDashboardInventory(events, [
  { name: 'doom', updatedAt: at(6).toISOString() },
  { name: 'server-only', updatedAt: at(7).toISOString() },
]);
assert.deepEqual(authoritative.map((panel) => panel.name), ['doom', 'server-only']);
assert.equal(authoritative[0].messageId, 'update-call');
assert.equal(authoritative[1].messageId, '');
assert.ok(authoritative.every((panel) => panel.updatedAt instanceof Date));
assert.deepEqual(reconcileDashboardInventory(events, []), [], 'Deleted dashboards must not be restored from historical panel events');

const revision = workspaceAssetRevision(events);
assert.equal(workspaceAssetRevision(events.slice(0, -1)), revision, 'Streaming assistant text must not trigger repeated dashboard inventory requests');
assert.notEqual(workspaceAssetRevision(events.slice(0, -2)), revision, 'New canonical asset events must refresh the sidebar immediately');

const restored = rehydrateChatEvents(JSON.parse(JSON.stringify(events)));
assert.deepEqual(projectWorkspaceAssets(restored), projected);
assert.equal(workspaceAssetRevision(restored), revision);

const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/app/components/TranscriptRenderer.tsx', import.meta.url), 'utf8');
assert.match(app, /projectWorkspaceAssets\(events\)/, 'Server-owned transcript events must feed the live workspace sidebar');
assert.match(app, /reconcileDashboardInventory\(events, dashboards\)/, 'The live sidebar must reconcile with server-authoritative dashboards');
assert.match(app, /onPush\('push\/panel-delete'/, 'Dashboard deletion pushes must update the live sidebar');
assert.match(app, /\[activeChat\?\.id, activeWorkspaceAssetRevision, activeVulcanEndpoint\]/, 'Asset inventory must not refresh once per streamed token');
assert.match(renderer, /\{renderNodes\}<\/div>[\s\S]*?data-assistant-attachments="true"/, 'Dashboard and file cards must render after the assistant message body');
assert.match(renderer, /attachmentNodes\.set\(`file:\$\{event\.file\.path\}`/, 'Repeated file presentations must produce one attachment card');
assert.match(renderer, /attachmentNodes\.set\(`panel:\$\{event\.panel\.name\}`/, 'Repeated dashboard updates must produce one attachment card');

console.log('Live canonical asset projection, latest-event deduplication, authoritative dashboard inventory, deletion, and stable streaming revisions verified.');
