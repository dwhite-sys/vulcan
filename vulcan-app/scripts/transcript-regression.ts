import assert from 'node:assert/strict';
import {
  applyLLMStreamEvent,
  createTurnStreamState,
  projectRenderAtoms,
  rehydrateChatEvents,
  sealTurnSemantic,
} from '../src/app/services/transcript.ts';
import { LLMClient } from '../src/app/services/llm.ts';
import type { ChatEvent, ToolEvent } from '../src/app/types/vulcan.ts';

const at = (offset: number) => new Date(1_700_000_000_000 + offset);

// Regression for the exact chronology bug seen in the UI:
// open_terminal -> narration -> switch_terminal must NEVER become
// narration -> open_terminal -> switch_terminal.
let events: ChatEvent[] = [
  { id: 'u1', type: 'user_message', content: 'Open a terminal', timestamp: at(0), runId: 'r1' },
  { id: 'think1', type: 'reasoning', content: 'Need a terminal', status: 'complete', timestamp: at(1), completedAt: at(2), runId: 'r1', turnId: 't1' },
  { id: 'open', type: 'tool', callId: 'c1', tool: 'open_terminal', arguments: {}, status: 'complete', result: { result: { ok: true, slot: 1 } }, timestamp: at(3), runId: 'r1', turnId: 't1' },
  { id: 'middle', type: 'assistant_text', content: "Terminal 1 is open. I'll switch to it so I can run commands.", status: 'complete', timestamp: at(4), runId: 'r1', turnId: 't2' },
  { id: 'think2', type: 'reasoning', content: 'Switch focus', status: 'complete', timestamp: at(5), completedAt: at(6), runId: 'r1', turnId: 't2' },
  { id: 'switch', type: 'tool', callId: 'c2', tool: 'switch_terminal', arguments: { slot: 1 }, status: 'complete', result: { result: { ok: true } }, timestamp: at(7), runId: 'r1', turnId: 't2' },
  { id: 'final', type: 'assistant_text', content: "Terminal's open and focused.", status: 'complete', timestamp: at(8), runId: 'r1', turnId: 't3' },
];

const expectedProjection = [
  { kind: 'single', id: 'u1', type: 'user_message' },
  { kind: 'actions', ids: ['think1', 'open'] },
  { kind: 'assistant_text', id: 'middle' },
  { kind: 'actions', ids: ['think2', 'switch'] },
  { kind: 'assistant_text', id: 'final' },
];
assert.deepEqual(projectRenderAtoms(events), expectedProjection);

// Persistence round-trip uses the exact same event schema as live rendering.
const restored = rehydrateChatEvents(JSON.parse(JSON.stringify(events)), false);
assert.deepEqual(projectRenderAtoms(restored), expectedProjection);
assert.ok(restored.every((event) => event.timestamp instanceof Date));

// Visualizations are durable transcript elements, not children of the action
// group that auto-collapses after their owning tool turn completes.
const visualizationEvents: ChatEvent[] = [
  { id: 'visual-user', type: 'user_message', content: 'Show me a diagram', timestamp: at(20), runId: 'visual-run' },
  { id: 'visual-thought', type: 'reasoning', content: 'Draw the pipeline', status: 'complete', timestamp: at(21), completedAt: at(22), runId: 'visual-run', turnId: 'visual-turn' },
  { id: 'visual-width', type: 'tool', callId: 'visual-width-call', tool: 'get_visualization_width', arguments: {}, status: 'complete', result: { result: { width: 800 } }, timestamp: at(23), runId: 'visual-run', turnId: 'visual-turn' },
  { id: 'visual-diagram', type: 'tool', callId: 'visual-call', tool: 'visualize', arguments: { type: 'mermaid', content: 'flowchart LR; A-->B' }, status: 'complete', result: { result: { ok: true } }, timestamp: at(24), runId: 'visual-run', turnId: 'visual-turn' },
  { id: 'visual-followup', type: 'tool', callId: 'visual-followup-call', tool: 'use_terminal', arguments: { cmd: 'true' }, status: 'complete', result: { result: { exit_code: 0 } }, timestamp: at(25), runId: 'visual-run', turnId: 'visual-turn' },
  { id: 'visual-text', type: 'assistant_text', content: 'Here is the pipeline.', status: 'complete', timestamp: at(26), runId: 'visual-run', turnId: 'visual-turn' },
];
const expectedVisualizationProjection = [
  { kind: 'single', id: 'visual-user', type: 'user_message' },
  { kind: 'actions', ids: ['visual-thought', 'visual-width'] },
  { kind: 'visualization', id: 'visual-diagram' },
  { kind: 'actions', ids: ['visual-followup'] },
  { kind: 'assistant_text', id: 'visual-text' },
];
assert.deepEqual(projectRenderAtoms(visualizationEvents), expectedVisualizationProjection);
assert.deepEqual(projectRenderAtoms(rehydrateChatEvents(JSON.parse(JSON.stringify(visualizationEvents)))), expectedVisualizationProjection);

// Dashboard and presented-file events stay in their original persisted positions,
// but their cards belong at the bottom of the owning assistant message. Repeated
// updates to the same dashboard/file produce one card containing the latest event.
const attachmentEvents: ChatEvent[] = [
  { id: 'attachment-user', type: 'user_message', content: 'Build DOOM', timestamp: at(30), runId: 'attachment-run' },
  { id: 'dashboard-tool', type: 'tool', callId: 'dashboard-call', tool: 'dashboard_create', arguments: { name: 'doom' }, status: 'complete', timestamp: at(31), runId: 'attachment-run', turnId: 'attachment-turn' },
  { id: 'dashboard-first', type: 'panel', panel: { name: 'doom', updatedAt: at(32), messageId: 'dashboard-tool' }, timestamp: at(32), runId: 'attachment-run', turnId: 'attachment-turn' },
  { id: 'attachment-narration', type: 'assistant_text', content: 'Testing the game.', status: 'complete', timestamp: at(33), runId: 'attachment-run', turnId: 'attachment-turn' },
  { id: 'file-first', type: 'presented_file', file: { path: 'doom/readme.md', name: 'readme.md', presentedAt: at(34), messageId: 'dashboard-tool' }, timestamp: at(34), runId: 'attachment-run', turnId: 'attachment-turn' },
  { id: 'dashboard-latest', type: 'panel', panel: { name: 'doom', updatedAt: at(35), messageId: 'dashboard-tool' }, timestamp: at(35), runId: 'attachment-run', turnId: 'attachment-turn' },
  { id: 'attachment-final', type: 'assistant_text', content: 'The DOOM dashboard is live.', status: 'complete', timestamp: at(36), runId: 'attachment-run', turnId: 'attachment-turn' },
];
const expectedAttachmentProjection = [
  { kind: 'single', id: 'attachment-user', type: 'user_message' },
  { kind: 'actions', ids: ['dashboard-tool'] },
  { kind: 'assistant_text', id: 'attachment-narration' },
  { kind: 'assistant_text', id: 'attachment-final' },
  { kind: 'panel', id: 'dashboard-latest' },
  { kind: 'presented_file', id: 'file-first' },
];
assert.deepEqual(projectRenderAtoms(attachmentEvents), expectedAttachmentProjection);
assert.deepEqual(projectRenderAtoms(rehydrateChatEvents(JSON.parse(JSON.stringify(attachmentEvents)))), expectedAttachmentProjection);
assert.deepEqual(attachmentEvents.map((event) => event.id), [
  'attachment-user', 'dashboard-tool', 'dashboard-first', 'attachment-narration',
  'file-first', 'dashboard-latest', 'attachment-final',
], 'The UI attachment projection must never reorder persisted/model-visible events');

// Streaming mutates the current semantic event without moving it, then crossing a
// semantic boundary appends a new immutable position.
let stream = createTurnStreamState([
  { id: 'u2', type: 'user_message', content: 'Test streaming', timestamp: at(10), runId: 'r2' },
]);
let idCounter = 0;
const context = { runId: 'r2', turnId: 'r2:t0', makeId: (kind: string) => `${kind}-${++idCounter}` };
stream = applyLLMStreamEvent(stream, { type: 'text_delta', delta: 'Term' }, context);
const textId = stream.activeSemanticId!;
const textIndex = stream.events.findIndex((event) => event.id === textId);
stream = applyLLMStreamEvent(stream, { type: 'text_delta', delta: 'inal 1' }, context);
assert.equal(stream.events.findIndex((event) => event.id === textId), textIndex);
assert.equal((stream.events[textIndex] as any).content, 'Terminal 1');
stream = applyLLMStreamEvent(stream, { type: 'tool_call_delta', index: 0, id: 'call-open', nameDelta: 'open_terminal', argumentsDelta: '{}' }, context);
assert.equal(stream.events.findIndex((event) => event.id === textId), textIndex);
assert.equal((stream.events[textIndex] as any).status, 'complete');
assert.deepEqual(projectRenderAtoms(stream.events).slice(-2), [
  { kind: 'assistant_text', id: textId },
  { kind: 'actions', ids: [stream.toolEventIds.get(0)!] },
]);

// A saved transient stream becomes interrupted on process restart, retaining bytes
// and array position instead of disappearing.
const transient = rehydrateChatEvents(JSON.parse(JSON.stringify(stream.events)), true);
const restoredText = transient.find((event) => event.id === textId) as any;
const restoredTool = transient.find((event) => event.id === stream.toolEventIds.get(0)) as ToolEvent;
assert.equal(restoredText.content, 'Terminal 1');
assert.equal(restoredTool.status, 'interrupted');

stream = sealTurnSemantic(stream);
events = stream.events;
assert.equal(events.findIndex((event) => event.id === textId), textIndex);

// The provider parser must also be streaming-safe when inline <think> tags are split
// across provider deltas AND transport chunks. Neither tags nor hidden reasoning may
// leak into the visible assistant_text event stream.
const originalFetch = globalThis.fetch;
try {
  const sseLines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '<thi' } }] })}\n`,
    `data:${JSON.stringify({ choices: [{ delta: { content: 'nk>hidden ' } }] })}\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'reasoning</thi' } }] })}\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'nk>Visible answer' } }] })}\n`,
    'data: [DONE]\n',
  ].join('');
  const bytes = new TextEncoder().encode(sseLines);
  const cuts = [7, 19, 41, 83, 129, bytes.length];
  let start = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const end of cuts) {
        if (end > start) controller.enqueue(bytes.slice(start, Math.min(end, bytes.length)));
        start = end;
      }
      controller.close();
    },
  });
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;

  const client = new LLMClient();
  client.setConfig({ baseUrl: 'http://test.invalid/v1', model: 'test' });
  const semantic: any[] = [];
  const response = await client.chat([{ role: 'user', content: 'x' }], [], (event) => semantic.push(event));
  assert.equal(response.thinking, 'hidden reasoning');
  assert.equal(response.content, 'Visible answer');
  assert.equal(semantic.filter((event) => event.type === 'text_delta').map((event) => event.delta).join(''), 'Visible answer');
  assert.equal(semantic.filter((event) => event.type === 'reasoning_delta').map((event) => event.delta).join(''), 'hidden reasoning');
  assert.ok(!JSON.stringify(semantic).includes('<think>'));
  assert.ok(!JSON.stringify(semantic).includes('</think>'));
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Transcript regression checks passed.');
