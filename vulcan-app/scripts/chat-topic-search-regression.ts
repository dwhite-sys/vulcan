import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterSidebarByQuery } from '../src/app/services/sidebarOrdering.ts';
import type { Chat, ChatFolder } from '../src/app/types/vulcan.ts';

const now = new Date('2026-08-23T10:00:00Z');
const folders: ChatFolder[] = [
  { id: 'projects', name: 'Projects', parentId: null, createdAt: now },
  { id: 'games', name: 'Games', parentId: 'projects', createdAt: now },
  { id: 'recipes', name: 'Recipes', parentId: null, createdAt: now },
];
const create = (id: string, title: string, folderId: string | null, tags: string[]): Chat => ({
  schemaVersion: 2, id, title, events: [], createdAt: now, updatedAt: now, folderId, tags,
});
const chats = [
  create('bella', 'A puzzling archive', 'games', ['sims save', 'python parsing']),
  create('bread', 'Weekend experiments', 'recipes', ['sourdough fermentation']),
  create('root', 'VPN setup', null, ['tailscale networking']),
];

assert.deepEqual(filterSidebarByQuery(chats, folders, 'save parsing').chats.map((chat) => chat.id), ['bella']);
assert.deepEqual(filterSidebarByQuery(chats, folders, 'save parsing').folders.map((folder) => folder.id), ['projects', 'games']);
assert.deepEqual(filterSidebarByQuery(chats, folders, 'SIMS python').chats.map((chat) => chat.id), ['bella']);
assert.deepEqual(filterSidebarByQuery(chats, folders, 'recipes').chats.map((chat) => chat.id), ['bread']);
assert.deepEqual(filterSidebarByQuery(chats, folders, 'vpn').chats.map((chat) => chat.id), ['root']);
assert.deepEqual(filterSidebarByQuery(chats, folders, 'unknown topic').chats, []);
assert.deepEqual(filterSidebarByQuery(chats, folders, 'needle', new Set(['bread'])).chats.map((chat) => chat.id), ['bread']);
assert.equal(filterSidebarByQuery(chats, folders, '').chats, chats);

const sidebar = readFileSync(new URL('../src/app/components/KitSidebar.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
assert.match(sidebar, /Search chats, tags, and messages/);
assert.match(sidebar, /filterSidebarByQuery/);
assert.match(sidebar, /value=\{query\}/);
assert.match(sidebar, /aria-label=\{branchMode \? \"Clear branch search\" : \"Clear chat search\"\}/);
assert.match(app, /loadChatTopics/);

console.log('Chat topic search regression checks passed.');
