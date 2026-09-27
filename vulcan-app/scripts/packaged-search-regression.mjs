import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), '..');
const chats = fs.readFileSync(path.join(root, 'vulcan', 'vulcan', 'chats.py'), 'utf8');
const ws = fs.readFileSync(path.join(root, 'vulcan', 'vulcan', 'ws_general.py'), 'utf8');

const requireText = (text, needle, message) => { if (!text.includes(needle)) throw new Error(message); };
requireText(chats, 'CREATE VIRTUAL TABLE IF NOT EXISTS transcript_search USING fts5', 'installable vulcan package is missing transcript_search FTS5');
requireText(chats, 'def search_current_transcripts', 'installable vulcan package is missing current-branch transcript search');
requireText(chats, 'def search_branches', 'installable vulcan package is missing branch transcript search');
requireText(chats, '_reindex_chat_search(connection, chat_id, metadata, events)', 'installable vulcan package does not refresh transcript FTS on save');
requireText(ws, '"chats/branch-search"', 'installable Vulcan websocket router is missing branch-search');
requireText(ws, 'chat_store.search_current_transcripts', 'installable Vulcan websocket search still returns metadata-only results');

requireText(chats, 'transcript_search.content AS message', 'installable search is not returning direct FTS message rows');
if (chats.includes('snippet(transcript_search')) throw new Error('installable search still builds FTS snippets before returning results');
if (ws.includes('search_chat_ids, query')) throw new Error('installable websocket search still runs a second metadata search');
console.log('packaged-search-regression: PASS');
