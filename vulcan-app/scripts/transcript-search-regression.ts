import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceSearchChatId, advanceSearchIndex, clampSearchIndex, firstSearchMatchPerEvent, hydrateTranscriptSearchMatches, searchTranscript, transcriptSearchDescriptors, unhydratedTranscriptSearchMatches } from '../src/app/services/transcriptSearch.ts';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(appRoot, 'src/app/App.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(appRoot, 'src/app/components/ChatInterface.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.join(appRoot, 'src/app/components/KitSidebar.tsx'), 'utf8');
const renderer = fs.readFileSync(path.join(appRoot, 'src/app/components/TranscriptRenderer.tsx'), 'utf8');

const now = new Date();
const events: any[] = [
  { id: 'u1', type: 'user_message', content: 'alpha needle beta', timestamp: now },
  { id: 'a1', type: 'assistant_text', content: 'needle again', status: 'complete', timestamp: now },
  { id: 'r1', type: 'reasoning', content: 'hidden needle thought', status: 'complete', timestamp: now },
  { id: 'u2', type: 'user_message', content: 'other', timestamp: now },
];
const matches = searchTranscript(events, 'needle');
assert.equal(matches.length, 3);
assert.deepEqual(matches.map((m) => m.blockIndex), [0, 1, 1]);
assert.deepEqual(matches.map((m) => m.eventId), ['u1', 'a1', 'r1']);
assert.deepEqual(matches.map((m) => m.occurrence), [0, 0, 0]);
assert.equal(clampSearchIndex(9, 3), 2);
assert.equal(advanceSearchIndex(2, 3, 1), 0);
assert.equal(advanceSearchIndex(0, 3, -1), 2);
assert.equal(advanceSearchChatId(['newest', 'middle', 'oldest'], 'middle', 1), 'oldest');
assert.equal(advanceSearchChatId(['newest', 'middle', 'oldest'], 'middle', -1), 'newest');
assert.equal(advanceSearchChatId(['newest', 'middle', 'oldest'], null, 1), 'newest');
assert.equal(advanceSearchChatId(['newest', 'middle', 'oldest'], null, -1), 'oldest');

const hydrated = hydrateTranscriptSearchMatches(events, [
  { event_id: 'a1', event_type: 'assistant_text', start: 0, end: 6, occurrence: 0 },
  { event_id: 'r1', event_type: 'reasoning', start: 7, end: 13, occurrence: 0 },
]);
assert.deepEqual(hydrated.map((m) => [m.eventId, m.blockIndex]), [['a1', 1], ['r1', 1]]);
const lightweight = unhydratedTranscriptSearchMatches([
  { event_id: 'a1', event_type: 'assistant_text', message: 'There is a needle here', timestamp: now.toISOString() },
  { event_id: 'r1', event_type: 'reasoning', message: 'Another needle', timestamp: now.toISOString() },
]);
assert.deepEqual(lightweight.map((m) => [m.eventId, m.blockIndex]), [['a1', -1], ['r1', -1]]);
assert.equal(lightweight[0].preview, 'There is a needle here');
assert.deepEqual(transcriptSearchDescriptors(lightweight).map((m) => m.event_id), ['a1', 'r1']);
assert.deepEqual(firstSearchMatchPerEvent([...matches, { ...matches[0], id: 'duplicate', occurrence: 1 }]).map((m) => m.eventId), ['u1', 'a1', 'r1']);


// The center search UI is gone; App owns one universal query and passes the
// selected per-chat occurrence into the existing transcript search renderer.
assert.doesNotMatch(chat, /Search this conversation/);
assert.match(chat, /searchQuery=\{searchQuery\}/);
assert.match(chat, /activeSearchMatch=\{activeSearchMatch\}/);
assert.match(app, /universalSearchQuery/);
assert.match(app, /searchHitIndexByChat/);
assert.match(app, /searchMatchesByChat/);
assert.match(app, /vulcan\.searchChats\(query\)/);
assert.match(app, /vulcan\.searchBranches\(activeChat\.id, query\)/);
assert.match(app, /unhydratedTranscriptSearchMatches\(result\.hits_by_chat/);
assert.match(app, /unhydratedTranscriptSearchMatches\(result\.hits_by_branch/);
assert.match(app, /firstSearchMatchPerEvent\(searchTranscript\(activeChat\.events/);
assert.match(app, /firstSearchMatchPerEvent\(searchTranscript\(selectedBranchEvents/);
assert.match(app, /Keep the last complete result set visible/);
assert.doesNotMatch(app, /hydrateTranscriptSearchMatches\(chat\.events, result\.hits_by_chat/);
assert.doesNotMatch(app, /hydrateTranscriptSearchMatches\(events, result\.hits_by_branch/);
assert.doesNotMatch(app, /for \(const chat of chats\) result\.set\(chat\.id, searchTranscript/);
assert.doesNotMatch(app, /hydrateTranscriptSearchMatches\(activeChat\.events/);
assert.match(app, /event\.key === 'F3' && \(event\.ctrlKey \|\| event\.metaKey\)/);
assert.match(app, /navigateSearchChat\(event\.shiftKey \? -1 : 1\)/);
assert.match(app, /event\.key === 'Enter' && modifier && !event\.altKey/);
assert.match(app, /if \(event\.ctrlKey \|\| event\.metaKey\) \{/);
assert.match(app, /event\.key === 'F3' && !event\.ctrlKey/);
assert.match(app, /universalSearchInputRef\.current\?\.focus/);
assert.match(sidebar, /CURRENT/);
assert.match(sidebar, /h-\[174px\]/);
assert.match(sidebar, /group-hover\/search-result:opacity-100/);
assert.match(sidebar, /ArrowUp/);
assert.match(sidebar, /ArrowDown/);
assert.match(sidebar, /matches:/);
assert.match(sidebar, /searchMatches\.length === 1 \? 'message' : 'messages'/);
assert.match(sidebar, /tags\.length === 1 \? 'auto-tag' : 'auto-tags'/);
assert.match(sidebar, /createPortal/);
assert.match(sidebar, /tags\.length >= 5/);
assert.match(sidebar, /flex-wrap justify-center/);
assert.match(sidebar, /getBoundingClientRect/);
assert.match(sidebar, /window\.innerWidth - width - margin/);
assert.match(sidebar, /w-\[calc\(100%\+62px\)\]/);
assert.match(sidebar, /text-\[8px\] leading-\[1\.25\]/);
assert.ok(sidebar.includes('<span> ({autoTagsMatched.length})</span>'));
assert.match(sidebar, /const message = match\.preview/);
assert.doesNotMatch(sidebar, /chat\.events\.map/);
assert.doesNotMatch(sidebar, /transcriptEventSearchText/);
assert.doesNotMatch(sidebar, /pseudoChat/);
assert.match(app, /setSearchMatchesByChat\(new Map\(next\)\)/);
assert.match(app, /requestAnimationFrame/);

assert.ok(sidebar.includes("<span> ({searchMatches.length})</span>"));
assert.doesNotMatch(sidebar, /message \{searchMatches\.length === 1 \? 'hit' : 'hits'\}/);
assert.match(sidebar, /!Boolean\(searchQuery\?\.trim\(\)\) && terminalStatus/);
assert.match(sidebar, /flex flex-shrink-0 flex-col items-end gap-0\.5/);
assert.match(renderer, /scrollToIndex\(props\.activeSearchMatch\.blockIndex/);
assert.match(renderer, /lastFlashedSearchMatchRef/);
assert.match(renderer, /data-transcript-block-index=\\"\$\{match\.blockIndex\}\\"/);
assert.match(renderer, /background: '#3a3321'/);
assert.match(renderer, /duration: 2000/);
assert.match(renderer, /easing: 'ease-out'/);
assert.match(renderer, /data-transcript-search-event-id/);
assert.match(renderer, /CSS as any\)\?\.highlights/);
console.log('Unified canonical-search + virtualized navigation regression: ok');
