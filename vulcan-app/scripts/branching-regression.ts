import assert from 'node:assert/strict';
import { createBranch, ensureBranching, renameBranch, suggestBranchTitle, branchEvents, orderedBranches, syncCurrentBranch } from '../src/app/services/branching.ts';
import { searchTranscript } from '../src/app/services/transcriptSearch.ts';
import type { Chat, UserMessageEvent, AssistantTextEvent } from '../src/app/types/vulcan.ts';

const u = (id: string, content: string, minute: number): UserMessageEvent => ({ id, type:'user_message', content, timestamp:new Date(`2026-09-13T21:${minute.toString().padStart(2,'0')}:00`) });
const a = (id: string, content: string, minute: number): AssistantTextEvent => ({ id, type:'assistant_text', content, status:'complete', timestamp:new Date(`2026-09-13T21:${minute.toString().padStart(2,'0')}:10`) });

const rootEvents = [u('u1','How should conversation branching work?',0), a('a1','Use a parent-only tree and derive alternate histories.',1), u('u2','Could graph navigation be more like a family tree?',2), a('a2','Yes, use straight orthogonal connectors.',3)];
const chat: Chat = { schemaVersion:2, id:'c1', title:'Vulcan branching architecture', events:rootEvents, createdAt:new Date('2026-09-13T21:00:00'), updatedAt:new Date('2026-09-13T21:03:10') };

const state = ensureBranching(chat);
assert.equal(state.branches.length, 1);
assert.deepEqual(branchEvents(chat, state.branches[0].id).map(e=>e.id), ['u1','a1','u2','a2']);

const editedEvents = [rootEvents[0], rootEvents[1], u('u2-edit','Could graph navigation be more like a family tree with straight lines?',4)];
const edit = createBranch(chat,'edit',state.currentBranchId,editedEvents);
assert.equal(edit.chat.branching?.branches.length, 2);
assert.equal(edit.branch.origin, 'edit');
assert.match(edit.branch.title.toLowerCase(), /(graph|navigation|family|straight|lines)/);
assert.deepEqual(branchEvents(edit.chat, edit.branch.id).map(e=>e.id), ['u1','a1','u2-edit']);
assert.equal(branchEvents(edit.chat, state.currentBranchId).at(-1)?.id, 'a2', 'editing must not mutate the original branch path');

const regenEvents = [...editedEvents, a('a3','Store parent links only; children are reverse lookups.',5)];
const regen = createBranch(edit.chat,'regen',edit.branch.id,regenEvents);
assert.equal(regen.branch.parentBranchId, edit.branch.id);
assert.equal(regen.chat.branching?.currentBranchId, regen.branch.id);

const jumpEvents = [...rootEvents, u('u3','Let us continue from this older branch and discuss search parity.',6)];
const jump = createBranch(regen.chat,'jump',state.currentBranchId,jumpEvents);
assert.equal(jump.branch.origin,'jump');
assert.match(jump.branch.title.toLowerCase(), /(continue|older|search|parity)/);

const renamed = renameBranch(jump.chat, jump.branch.id, 'Search parity');
const renamedBranch = renamed.branching?.branches.find(b=>b.id===jump.branch.id);
assert.equal(renamedBranch?.title,'Search parity');
assert.equal(renamedBranch?.titleSource,'user');
const afterManualContinuation = syncCurrentBranch(renamed, [...branchEvents(renamed, jump.branch.id), a('a-jump','Search should preserve every branch that contains shared ancestry.',7)]);
assert.equal(afterManualContinuation.branching?.branches.find(b=>b.id===jump.branch.id)?.title, 'Search parity', 'manual titles must never be overwritten by automatic refinement');

// Search intentionally returns every branch whose visible path contains the hit,
// including inherited/shared ancestry. Ordering remains chronological newest-first.
const sharedMatches = (afterManualContinuation.branching?.branches ?? [])
  .filter(branch => searchTranscript(branchEvents(afterManualContinuation, branch.id), 'conversation branching').length > 0);
assert.ok(sharedMatches.length >= 2, 'shared-ancestry search hits must remain visible on multiple branches');
const ordered = orderedBranches(afterManualContinuation);
for (let i = 1; i < ordered.length; i++) assert.ok(+new Date(ordered[i - 1].createdAt) >= +new Date(ordered[i].createdAt));

// Shared ancestry is intentionally searchable on every descendant branch; snapshots preserve it.
for (const branch of renamed.branching?.branches ?? []) {
  if (branch.id !== state.currentBranchId) assert.equal(branchEvents(renamed, branch.id)[0]?.id, 'u1');
}
assert.equal(renamed.branching?.nodes.filter(node => node.event.id === 'u1').length, 1, 'shared ancestry must be stored once in the parent-only event graph');

// Auto-title sanity checks for the lightweight recognizer.
assert.match(suggestBranchTitle('edit', rootEvents, editedEvents).toLowerCase(), /(graph|navigation|family|straight|lines)/);
assert.match(suggestBranchTitle('jump', rootEvents, jumpEvents).toLowerCase(), /(continue|older|search|parity)/);

console.log('branching regression: ok');
