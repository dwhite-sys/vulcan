import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { ChatLoadCoordinator, SupersededChatLoadError, reconcileChatSummaries } from '../src/app/services/chatLoading.ts';

const app = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const start = app.indexOf('  const handleSelectChat =');
const program = stripTypeScriptTypes(app.slice(start, app.indexOf('\n  useEffect(() => {', start))
  + app.slice(app.indexOf('  const subscribePayload ='), app.indexOf('  const flushRunStreams ='))
  + '\nglobalThis.select = handleSelectChat; globalThis.subscribe = subscribeChat;');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const chat = (id: string) => ({ id, title: id, schemaVersion: 2, _summaryOnly: true, events: [], updatedAt: new Date(0) });
const response = (id: string, revision = id) => ({ chat: { ...chat(id), _summaryOnly: false, events: [{ id: `${id}-event` }] }, chat_revision: revision, seqs: {}, status: 'idle' });
function harness() {
  const requests: any[] = [], errors: string[] = [];
  const ctx: any = {
    chats: ['a', 'b', 'c'].map(chat), activeChat: null,
    chatsRef: { current: [] }, activeChatRef: { current: null }, activeChatIdRef: { current: null },
    openingChatIdRef: { current: null }, chatSelectionGenerationRef: { current: 0 },
    serverContextGenerationRef: { current: 0 }, chatConnectionGenerationRef: { current: 0 },
    pendingChatIdRef: { current: null }, subscribedChatIdRef: { current: null },
    chatLoadsRef: { current: new ChatLoadCoordinator() }, chatSnapshotsRef: { current: new Map() },
    runStreamQueueRef: { current: new Map() }, runGapChatsRef: { current: new Set() }, runResyncRef: { current: new Set() },
    CLIENT_CAPABILITIES: [], SupersededChatLoadError,
    vulcan: { generalWS: { send(type: string, payload: any) { return new Promise((resolve, reject) => requests.push({ type, payload, resolve, reject })); } } },
    hydrateChatPayload(raw: any) { return raw?.schemaVersion === 2 && Array.isArray(raw.events) ? { ...raw, _summaryOnly: false } : null; },
    attachSeqs() {}, syncCurrentBranch: (c: any, events: any[]) => ({ ...c, events }),
    setChats(fn: any) { ctx.chats = fn(ctx.chats); ctx.chatsRef.current = ctx.chats; },
    setActiveChat(value: any) { ctx.activeChat = typeof value === 'function' ? value(ctx.activeChat) : value; ctx.activeChatRef.current = ctx.activeChat; ctx.activeChatIdRef.current = ctx.activeChat?.id; },
    setOpeningChatId(value: any) { ctx.opening = value; },
    setProcessing(value: any) { ctx.processing = value; }, setQuestionBatch(value: any) { ctx.question = value; },
    setPendingChat() {}, projectWorkspaceAssets: () => ({}), setPresentedFiles() {}, setPanels() {}, setAttachments() {}, setBranchMode() {}, setSelectedBranchId() {},
    console: { warn() {} }, toast: { error: (message: string) => errors.push(message) },
  };
  ctx.chatsRef.current = ctx.chats;
  vm.runInNewContext(program, ctx);
  return { ctx, requests, errors };
}

// Execute the actual renderer selection handler, not a copy of its algorithm.
{
  const { ctx, requests, errors } = harness();
  for (let i = 0; i < 12; i++) ctx.select('a');
  assert.equal(requests.length, 1);
  assert.equal(ctx.chatSelectionGenerationRef.current, 1);
  assert.equal(ctx.opening, 'a');
  requests[0].resolve(response('a')); await tick();
  assert.equal(ctx.activeChat.id, 'a');
  assert.equal(ctx.chats[0]._summaryOnly, false);
  assert.equal(ctx.opening, null);
  assert.equal(errors.length, 0);
}
// Only the latest unsent destination runs; superseded valid replies are cached.
{
  const { ctx, requests } = harness();
  ctx.select('a'); ctx.select('b'); ctx.select('c');
  assert.equal(requests.length, 1);
  requests[0].resolve(response('a')); await tick();
  assert.equal(ctx.chats[0]._summaryOnly, false);
  assert.equal(ctx.activeChat, null);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].payload.chat_id, 'c');
  requests[1].resolve(response('c')); await tick();
  assert.equal(ctx.activeChat.id, 'c');
}
// An unknown/deleted sidebar target must not invalidate a valid pending load.
{
  const { ctx, requests } = harness();
  ctx.select('a'); ctx.select('missing');
  requests[0].resolve(response('a')); await tick();
  assert.equal(ctx.activeChat.id, 'a');
  assert.equal(ctx.opening, null);
}
// Returning to the running destination cancels the obsolete queued load.
{
  const { ctx, requests } = harness();
  ctx.select('a'); ctx.select('b'); ctx.select('a');
  requests[0].resolve(response('a')); await tick();
  assert.equal(requests.length, 1);
  assert.equal(ctx.activeChat.id, 'a');
}
// Reproduce the incident: earlier success + later timeout. The earlier chat
// remains available and a cached reopen requests only revision validation.
{
  const { ctx, requests, errors } = harness();
  ctx.select('a'); ctx.select('b');
  requests[0].resolve(response('a', 'r1')); await tick();
  requests[1].reject(new Error('Request timed out')); await tick();
  assert.equal(errors.length, 1);
  assert.equal(ctx.opening, null);
  ctx.select('a');
  assert.equal(ctx.activeChat.id, 'a');
  assert.equal(requests[2].payload.known_revision, 'r1');
  const events = ctx.activeChat.events;
  requests[2].resolve({ chat_unchanged: true, chat_revision: 'r1', status: 'idle', seqs: {} }); await tick();
  assert.equal(ctx.activeChat.events, events);
  assert.equal(ctx.processing, false);
  assert.equal(ctx.question, null);
}
// An acknowledgement cannot validate local edits made during its round trip.
{
  const { ctx, requests } = harness();
  ctx.select('a'); requests[0].resolve(response('a', 'r1')); await tick();
  const pending = ctx.subscribe('a');
  ctx.setActiveChat({ ...ctx.activeChat, events: [...ctx.activeChat.events, { id: 'edit' }] });
  requests[1].resolve({ chat_unchanged: true, chat_revision: 'r1', seqs: {}, status: 'idle' }); await tick();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].payload.known_revision, undefined);
  requests[2].resolve(response('a', 'r2')); await pending;
}
// Delta-gap recovery must explicitly fetch a full authoritative snapshot.
{
  const { ctx, requests } = harness();
  ctx.select('a'); requests[0].resolve(response('a', 'r1')); await tick();
  const pending = ctx.subscribe('a', true);
  assert.equal(requests[1].payload.known_revision, undefined);
  requests[1].resolve(response('a', 'r2')); await pending;
}
// A mismatched acknowledgement is not a valid cache hit.
{
  const { ctx, requests } = harness();
  ctx.select('a'); requests[0].resolve(response('a', 'r1')); await tick();
  const pending = ctx.subscribe('a');
  requests[1].resolve({ chat_unchanged: true, chat_revision: 'wrong-revision', seqs: {}, status: 'idle' }); await tick();
  assert.equal(requests[2].payload.known_revision, undefined);
  requests[2].resolve(response('a', 'r2')); await pending;
}
// Never select or cache a transcript returned under the wrong chat ID.
{
  const { ctx, requests, errors } = harness();
  ctx.select('a'); requests[0].resolve(response('b')); await tick();
  assert.equal(ctx.activeChat, null);
  assert.equal(ctx.chats[0]._summaryOnly, true);
  assert.equal(errors.length, 1);
}
// Never cache a response delivered after a harness switch.
{
  const { ctx, requests } = harness();
  ctx.select('a');
  ctx.serverContextGenerationRef.current++; ctx.chatSelectionGenerationRef.current++;
  ctx.chatLoadsRef.current.reset();
  requests[0].resolve(response('a')); await tick();
  assert.equal(ctx.chats[0]._summaryOnly, true);
  assert.equal(ctx.chatSnapshotsRef.current.size, 0);
  assert.equal(ctx.activeChat, null);
}
// Reconnect preserves matching hydrated histories and drops changed ones.
{
  const cached = { ...chat('a'), _summaryOnly: false, events: [{ id: 'history' }] };
  const [same] = reconcileChatSummaries([chat('a')], [cached]);
  assert.equal(same.events, cached.events);
  assert.equal(same._summaryOnly, false);
  const [changed] = reconcileChatSummaries([{ ...chat('a'), updatedAt: new Date(1) }], [cached]);
  assert.equal(changed._summaryOnly, true);
}
// Old connection completion cannot remove or advance the new connection's work.
{
  const coordinator = new ChatLoadCoordinator<number>();
  let finishOld!: (n: number) => void, finishNew!: (n: number) => void;
  const old = coordinator.request('a', () => new Promise<number>((resolve) => { finishOld = resolve; }));
  const oldResult = old.catch((error) => error);
  const queued = coordinator.request('b', async () => { throw new Error('obsolete queued work ran'); });
  const queuedResult = queued.catch((error) => error);
  coordinator.reset();
  const current = coordinator.request('a', () => new Promise<number>((resolve) => { finishNew = resolve; }));
  finishOld(1); await tick();
  assert.equal(coordinator.request('a', async () => 99), current);
  finishNew(2);
  assert.equal(await current, 2);
  assert.ok(await oldResult instanceof SupersededChatLoadError);
  assert.ok(await queuedResult instanceof SupersededChatLoadError);
}
console.log('Chat loading regression: ok');
