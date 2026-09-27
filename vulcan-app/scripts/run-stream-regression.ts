import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRunDelta,
  applyRunEventSnapshot,
  applyRunStreamBatch,
  attachSeqs,
  seqsOf,
  type RunStreamMessage,
} from '../src/app/services/runStream.ts';
import type { Chat, ChatEvent } from '../src/app/types/vulcan.ts';
import { branchEvents, compactBranchingForWire, ensureBranching } from '../src/app/services/branching.ts';

const at = new Date(1_700_000_000_000);
const text = (id: string, content = ''): ChatEvent => ({
  id, type: 'assistant_text', content, status: 'streaming', timestamp: at,
} as unknown as ChatEvent);
const history = (count: number): ChatEvent[] => Array.from({ length: count }, (_, index) => ({
  id: `h${index}`, type: 'user_message', content: `history ${index}`, timestamp: at,
} as unknown as ChatEvent));
const delta = (eventId: string, seq: number, content: string): RunStreamMessage => ({
  kind: 'delta', payload: { chat_id: 'c', event_id: eventId, seq, append: { content } },
});
const snapshot = (event: ChatEvent, seq: number): RunStreamMessage => ({
  kind: 'event', payload: { chat_id: 'c', event, seq },
});

// Creation snapshot then contiguous deltas reconstruct the text exactly.
{
  const start = history(3);
  const result = applyRunStreamBatch(start, [
    snapshot(text('live'), 0), delta('live', 1, 'Hel'), delta('live', 2, 'lo'), delta('live', 3, ' world'),
  ]);
  assert.equal(result.gap, false);
  assert.equal((result.events.at(-1) as any).content, 'Hello world');
  assert.equal(seqsOf(result.events).get('live'), 3);
  // Purity: the input array is untouched and keeps its own (empty) seqs.
  assert.equal(start.length, 3);
  assert.equal(seqsOf(start).size, 0);
  // Re-applying the same batch to the original array yields the same result
  // (React may invoke state updaters twice).
  const again = applyRunStreamBatch(start, [
    snapshot(text('live'), 0), delta('live', 1, 'Hel'), delta('live', 2, 'lo'), delta('live', 3, ' world'),
  ]);
  assert.equal((again.events.at(-1) as any).content, 'Hello world');
}

// Deltas already contained in a newer snapshot are ignored (no duplication).
{
  const base = attachSeqs([text('live', 'abc')], { live: 5 });
  const result = applyRunStreamBatch(base, [delta('live', 4, 'X'), delta('live', 5, 'Y'), delta('live', 6, 'd')]);
  assert.equal((result.events[0] as any).content, 'abcd');
  assert.equal(result.gap, false);
}

// A gap (missing seq, or unknown event) is reported, never applied.
{
  const base = attachSeqs([text('live', 'abc')], { live: 1 });
  const missing = applyRunStreamBatch(base, [delta('live', 3, 'lost')]);
  assert.equal(missing.gap, true);
  assert.equal(missing.changed, false);
  const unknown = applyRunStreamBatch(base, [delta('other', 1, 'x')]);
  assert.equal(unknown.gap, true);
}

// Older snapshots never regress content; seq-less (legacy) snapshots always apply.
{
  const base = attachSeqs([text('live', 'newer content')], { live: 9 });
  const stale = applyRunEventSnapshot(base, new Map(seqsOf(base)), { chat_id: 'c', event: text('live', 'old'), seq: 3 });
  assert.equal(stale.outcome, 'stale');
  const legacy = applyRunEventSnapshot(base, new Map(seqsOf(base)), { chat_id: 'c', event: text('live', 'legacy') });
  assert.equal(legacy.outcome, 'applied');
  assert.equal((legacy.events[0] as any).content, 'legacy');
}

// A full snapshot resets seqs; later deltas continue from it.
{
  const base = attachSeqs([text('live', 'partial')], { live: 2 });
  const result = applyRunStreamBatch(base, [
    { kind: 'full', events: [text('live', 'complete body')], seqs: { live: 7 } },
    delta('live', 8, '!'),
  ]);
  assert.equal(result.full, true);
  assert.equal((result.events[0] as any).content, 'complete body!');
}

// Extend/set fields (reasoning details, tool call id).
{
  const base = attachSeqs([{ ...text('tool'), type: 'tool', tool: 'vis', rawArguments: '{' } as any], { tool: 0 });
  const result = applyRunDelta(base, new Map(seqsOf(base)), {
    chat_id: 'c', event_id: 'tool', seq: 1,
    append: { tool: 'ualize', rawArguments: '"a":1}' }, set: { callId: 'call-1' }, extend: { reasoningDetails: [{ t: 1 }] },
  });
  const event = result.events[0] as any;
  assert.equal(event.tool, 'visualize');
  assert.equal(event.rawArguments, '{"a":1}');
  assert.equal(event.callId, 'call-1');
  assert.deepEqual(event.reasoningDetails, [{ t: 1 }]);
}

// Per-token work stays flat as the transcript grows: one copy per frame batch,
// O(1) per delta — not a transcript map per token.
{
  const timeFor = (historyLength: number) => {
    let events = attachSeqs([...history(historyLength), text('live')], { live: 0 });
    const started = performance.now();
    for (let frame = 0; frame < 200; frame += 1) {
      const batch: RunStreamMessage[] = [];
      for (let token = 0; token < 25; token += 1) {
        const seq = frame * 25 + token + 1;
        batch.push(delta('live', seq, 'tok '));
      }
      events = applyRunStreamBatch(events, batch).events;
    }
    assert.equal((events.at(-1) as any).content.length, 200 * 25 * 4);
    return performance.now() - started;
  };
  timeFor(10); // warm up
  const small = timeFor(10);
  const large = timeFor(5000);
  assert.ok(large < small * 20 + 50, `delta cost grew with history: ${small.toFixed(1)}ms vs ${large.toFixed(1)}ms`);
}

// The current branch reads the live transcript directly (correct while a run
// streams, with no per-event topology rebuild); compact wire form sends each
// event once.
{
  const events = [...history(2), text('live', 'streamed')];
  const chat = { id: 'c', title: 't', createdAt: at, updatedAt: at, events: events.slice(0, 2) } as unknown as Chat;
  const branching = ensureBranching(chat);
  const streaming = { ...chat, events, branching } as Chat;
  assert.deepEqual(branchEvents(streaming, branching.currentBranchId).map((event) => event.id), ['h0', 'h1', 'live']);
  const offPath = { event: text('alt', 'alternate'), parentId: 'h0' };
  const wire = compactBranchingForWire({ ...branching, nodes: [...branching.nodes, offPath] }, events);
  assert.ok(wire.nodes.every((node: any) => !('event' in node) && node.eventId));
  assert.deepEqual(wire.offPathEvents.map((event: any) => event.id), ['alt']);
}

// Structural guarantees in the renderer wiring.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'src/app/App.tsx'), 'utf8');
const deltaHandler = app.slice(app.indexOf("onPush('push/run-delta'"), app.indexOf("onPush('push/chat-updated'"));
assert.ok(deltaHandler.length > 0);
assert.doesNotMatch(deltaHandler, /syncCurrentBranch/, 'token deltas must not rebuild branch topology');
const flush = app.slice(app.indexOf('const flushRunStreams = () =>'), app.indexOf('const scheduleRunFlush = () =>'));
assert.match(flush, /result\.full && chat\.branching \? syncCurrentBranch/, 'branch sync only at full-snapshot boundaries');
assert.match(flush, /chat\._summaryOnly\) return chat/, 'sidebar summaries are never given partial transcripts');
assert.match(flush, /boundaries\.length/, 'the sidebar list only receives authoritative boundaries');
assert.doesNotMatch(app, /\}, \[activeChat\?\.id, connected\]\);/, 'subscription must not re-run on Etna health changes');
assert.match(app, /Reconnect has exactly one owner/);
const select = app.slice(app.indexOf('const handleSelectChat = (chatId: string) =>'), app.indexOf('const searchHitIndex ='));
assert.doesNotMatch(select, /loadChat\(/, 'chat open must not hydrate via chats/get and then subscribe again');
assert.match(select, /'runs\/subscribe'/);

console.log('Run stream regression: ok');
