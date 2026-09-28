import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messageContextItems, mergeEditedAttachments, splitComposerContext } from '../src/app/services/messageEditing.ts';

const quote = { id: 'q1', text: 'quoted', messageId: 'm0', sourceRole: 'assistant' as const, start: 2, end: 8 };
const reference = { id: 'r1', path: '/workspace/a.ts', startLine: 3, endLine: 5 };
const element = { id: 'e1', designId: 'board', locator: 'button.save', hierarchyAddress: 'body > button.save', tagName: 'button' };

const reconstructed = messageContextItems({
  quotes: [quote],
  references: [reference],
  elements: [element],
  contextOrder: ['r1', 'q1', 'e1'],
});
assert.deepEqual(reconstructed.map((item) => [item.kind, item.id]), [
  ['reference', 'r1'], ['quote', 'q1'], ['element', 'e1'],
], 'edit mode must reconstruct the complete ordered composer context');

const split = splitComposerContext(reconstructed);
assert.deepEqual(split.contextOrder, ['r1', 'q1', 'e1']);
assert.deepEqual(split.quotes, [quote]);
assert.deepEqual(split.references, [reference]);
assert.deepEqual(split.elements, [element]);

const oldImage = { name: 'old.png', size: 10, type: 'image/png', dataUrl: 'data:image/png;base64,old' };
const keptFile = { name: 'keep.txt', size: 20, type: 'text/plain' };
const newFile = { name: 'new.txt', size: 30, type: 'text/plain' };
assert.deepEqual(
  mergeEditedAttachments([keptFile], [newFile]),
  [keptFile, newFile],
  'removed original attachments must not be silently reintroduced',
);
assert.ok(!mergeEditedAttachments([keptFile], [newFile]).includes(oldImage));

const chat = readFileSync(new URL('../src/app/components/ChatInterface.tsx', import.meta.url), 'utf8');
const composer = readFileSync(new URL('../src/app/components/MessageComposer.tsx', import.meta.url), 'utf8');
const quoteComposer = readFileSync(new URL('../src/app/components/QuoteComposer.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/app/components/TranscriptRenderer.tsx', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/app/types/vulcan.ts', import.meta.url), 'utf8');
const combined = [chat, composer, quoteComposer, app, renderer, types].join('\n');

assert.match(chat, /activeComposerRef\.current === 'edit'/, 'quote/reference routing must distinguish the focused edit composer');
assert.match(chat, /addEditFiles/, 'edit mode must use the attachment upload path');
assert.match(composer, /<KitToggleMenu/, 'shared composer must expose kit toggles');
assert.match(composer, /<SkillToggleMenu/, 'shared composer must expose skill toggles');
assert.match(composer, /existingAttachments/, 'shared composer must render removable persisted attachments');
assert.match(quoteComposer, /vulcan-\(quote\|reference\|element\)/, 'composer must hydrate persisted inline context tokens back into editable reference nodes');
assert.match(app, /mergeEditedAttachments\(payload\.attachments, newAttachments\)/, 'edit submission must replace attachment selection instead of inheriting originals implicitly');
assert.match(app, /createBranch\(activeChat, 'edit'/, 'editing a historical user message must materialize an EDIT branch instead of destroying the prior path');
assert.match(app, /createBranch\(activeChat, 'regen'/, 'retrying must materialize a REGEN branch instead of destroying the prior path');

console.log('message edit regression: ok');
