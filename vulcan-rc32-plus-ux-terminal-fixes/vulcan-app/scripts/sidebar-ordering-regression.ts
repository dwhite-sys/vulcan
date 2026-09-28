import assert from 'node:assert/strict';
import { buildFolderRecency, directChatsByRecency, directFoldersByRecency } from '../src/app/services/sidebarOrdering.ts';
import type { Chat, ChatFolder } from '../src/app/types/vulcan.ts';

const chat = (id: string, updatedAt: string, folderId: string | null): Chat => ({
  schemaVersion: 2,
  id,
  title: id,
  events: [],
  createdAt: new Date(updatedAt),
  updatedAt: new Date(updatedAt),
  folderId,
});
const folder = (id: string, parentId: string | null, createdAt: string): ChatFolder => ({
  id,
  name: id,
  parentId,
  createdAt: new Date(createdAt),
});

const chats = [
  chat('root-old', '2026-08-19T20:00:00Z', null),
  chat('root-new', '2026-08-19T20:30:00Z', null),
  chat('direct-in-a', '2026-08-19T20:10:00Z', 'a'),
  chat('deep-newest', '2026-08-19T20:45:00Z', 'a-child'),
  chat('in-b', '2026-08-19T20:40:00Z', 'b'),
];
const folders = [
  folder('a', null, '2026-08-19T19:00:00Z'),
  folder('a-child', 'a', '2026-08-19T19:05:00Z'),
  folder('b', null, '2026-08-19T19:10:00Z'),
];

assert.deepEqual(directChatsByRecency(chats, null).map((c) => c.id), ['root-new', 'root-old']);
const recency = buildFolderRecency(chats, folders);
assert.equal(recency.get('a')?.toISOString(), '2026-08-19T20:45:00.000Z');
assert.equal(recency.get('a-child')?.toISOString(), '2026-08-19T20:45:00.000Z');
assert.equal(recency.get('b')?.toISOString(), '2026-08-19T20:40:00.000Z');
assert.deepEqual(directFoldersByRecency(folders, null, recency).map((f) => f.id), ['a', 'b']);

console.log('Sidebar ordering regression checks passed.');
