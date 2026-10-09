import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Execute the active renderer function with transport/UI doubles, so an
// undeclared option fails exactly as it does when sending from a real chat.
const app = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const start = app.indexOf('  const runInference = async (');
const end = app.indexOf('  // ── Live run transcript', start);
assert.ok(start >= 0 && end > start);
const executable = stripTypeScriptTypes(app.slice(start, end));

async function exercise({ pending = false, resume = false, reference = true, stale = false } = {}) {
  const requests = [];
  const errors = [];
  const subscriptions = [];
  const scope = {
    llmClient: { getConfig: () => ({ providerId: 'test', model: 'test' }) },
    loadProviders: () => [{ id: 'test', networkPointOfView: 'server' }],
    getEtnaClientDeviceId: () => 'device',
    setChats: () => {},
    toolSemanticIndexRef: { current: null },
    repairToolSemanticIndex: async () => null,
    kitsWithTools: [],
    vulcanSettings: {},
    enabledKits: [],
    disabledTools: new Set(),
    skills: [],
    etnaSkillDescriptors: [],
    renderWidthRef: { current: 800 },
    isVisionModel: () => false,
    selectedModel: 'test',
    chatForWire: (chat) => chat,
    CLIENT_CAPABILITIES: [],
    vulcan: { generalWS: {
      hasServerCapability: () => reference,
      send: async (type, payload) => {
        requests.push({ type, payload });
        if (stale && requests.length === 1) throw new Error('stale_base');
        return { status: 'running' };
      },
    } },
    subscribeChat: async (id) => subscriptions.push(id),
    pendingChatIdRef: { current: pending ? 'chat' : null },
    setPendingChat: () => {},
    activeChatIdRef: { current: 'chat' },
    setProcessing: () => {},
    toast: { error: (error) => errors.push(error) },
  };
  const run = new Function(...Object.keys(scope), `${executable}\nreturn runInference;`)(...Object.values(scope));
  const history = [{ id: 'prior', type: 'assistant_text', content: 'Earlier reply' }];
  const events = resume ? history : [...history, { id: 'new', type: 'user_message', content: 'Hello' }];
  const args = [{ id: 'chat', title: 'Existing chat', events: history }, pending, events, resume ? '' : 'Hello'];
  // Ordinary sends omit the fifth argument, as handleSendMessage does.
  if (resume) args.push(true);
  await run(...args);
  assert.deepEqual(errors, [], 'Run startup must not produce an error toast');
  assert.equal(requests.length, stale ? 2 : 1);
  assert.ok(requests.every((request) => request.type === 'runs/start'));
  assert.equal(requests[0].payload.options.resume, resume);
  assert.deepEqual(subscriptions, resume ? ['chat'] : []);
  if (!pending && !resume && reference) {
    assert.deepEqual(requests[0].payload.chat_ref, { base_len: 1, base_last_id: 'prior', new_events: events.slice(-1) });
  } else {
    assert.equal(requests[0].payload.chat_ref, undefined);
    assert.deepEqual(requests[0].payload.chat.events, events);
  }
  if (stale) {
    assert.equal(requests[1].payload.chat_ref, undefined);
    assert.deepEqual(requests[1].payload.chat.events, events);
  }
}

await exercise();
await exercise({ reference: false });
await exercise({ pending: true });
await exercise({ resume: true });
await exercise({ stale: true });
console.log('Renderer run start: existing chat, legacy server, new chat, resume, and stale-base fallback: ok');
