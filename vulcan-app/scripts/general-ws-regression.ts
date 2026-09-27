import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

class MockSecureWebSocket {
  static instances: MockSecureWebSocket[] = [];

  url: string;
  connected = false;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (message: any) => void;
  onclose?: (event: any) => void;
  onerror?: (error: Error) => void;

  constructor(url: string) {
    this.url = url;
    MockSecureWebSocket.instances.push(this);
  }

  open() {
    this.connected = true;
    this.onopen?.();
  }

  receive(message: any) {
    this.onmessage?.(message);
  }

  async send(message: any) {
    this.sent.push(message);
  }

  close() {
    this.connected = false;
    queueMicrotask(() => this.onclose?.({ code: 1000 }));
  }

  fail(error: Error) {
    this.onerror?.(error);
    this.close();
  }
}

const context = createContext({
  crypto: globalThis.crypto,
  clearTimeout,
  setTimeout,
});
const passwordQueue: any[] = [];
const confirmedPasswords: any[] = [];
const rejectedPasswords: any[] = [];
const source = readFileSync(new URL('../src/app/services/ws.ts', import.meta.url), 'utf8');
const module = new SourceTextModule(stripTypeScriptTypes(source), { context });

await module.link((specifier) => {
  if (specifier === './secureWebSocket') {
    return new SyntheticModule(['SecureWebSocket'], function () {
      this.setExport('SecureWebSocket', MockSecureWebSocket);
    }, { context });
  }
  if (specifier === './serverPasswordPrompt') {
    return new SyntheticModule(['requestServerPassword', 'confirmServerPassword', 'rejectServerPassword'], function () {
      this.setExport('requestServerPassword', async () => passwordQueue.shift()
        ?? { password: 'test-password', remember: false, remembered: false });
      this.setExport('confirmServerPassword', async (endpoint: string, credentials: any) => {
        confirmedPasswords.push({ endpoint, ...credentials });
      });
      this.setExport('rejectServerPassword', async (endpoint: string, credentials: any) => {
        rejectedPasswords.push({ endpoint, ...credentials });
      });
    }, { context });
  }
  if (specifier === './vulcanEndpoint') {
    return new SyntheticModule(['getVulcanWsBaseUrl'], function () {
      this.setExport('getVulcanWsBaseUrl', () => 'ws://localhost:8468');
    }, { context });
  }
  throw new Error(`Unexpected dependency: ${specifier}`);
});
await module.evaluate();

const { generalWS, setGeneralWSBaseUrl } = module.namespace as any;
const local = MockSecureWebSocket.instances.at(-1)!;
assert.equal(local.url, 'ws://localhost:8468/ws/general');
local.open();
local.receive({ type: 'push/connected', payload: { requires_auth: false } });
assert.equal(generalWS.authenticated, true);

setGeneralWSBaseUrl('ws://100.124.49.123:8468');
const target = MockSecureWebSocket.instances.at(-1)!;
assert.equal(target.url, 'ws://100.124.49.123:8468/ws/general');
assert.equal(generalWS.authenticated, false);

const hydration = [
  generalWS.send('chats/list', {}),
  generalWS.send('chat-folders/list', {}),
  generalWS.send('containers/lifecycle', {}),
  generalWS.send('library/status', {}),
];
await Promise.resolve();
assert.deepEqual(target.sent, [], 'Hydration must wait for the target secure session');

target.open();
target.receive({ type: 'push/connected', payload: { requires_auth: false } });
await Promise.resolve();
await Promise.resolve();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(target.sent.length, 4, 'All hydration requests must use the newly authenticated socket');
for (const request of target.sent) {
  target.receive({ id: request.id, type: `${request.type}/response`, payload: { server: 'target' } });
}
assert.deepEqual(await Promise.all(hydration), Array.from({ length: 4 }, () => ({ server: 'target' })));

setGeneralWSBaseUrl('ws://pending.example:8468');
const superseded = MockSecureWebSocket.instances.at(-1)!;
const obsoleteRequest = generalWS.send('chats/list', {});
setGeneralWSBaseUrl('ws://replacement.example:8468');
await assert.rejects(obsoleteRequest, /server changed|connection changed/i,
  'Requests belonging to the previous server must not resume against its replacement');
superseded.receive({ type: 'push/connected', payload: { requires_auth: false } });
assert.equal(generalWS.authenticated, false, 'Late events from a discarded socket must remain isolated');

const replacement = MockSecureWebSocket.instances.at(-1)!;
const failedHydration = generalWS.send('chat-folders/list', {});
replacement.fail(new Error('Harness identity requires approval, but the trust dialog is unavailable.'));
await assert.rejects(failedHydration, /Harness identity requires approval/,
  'Secure handshake failures must retain the actionable trust or identity error');

setGeneralWSBaseUrl('ws://secured.example:8468');
const secured = MockSecureWebSocket.instances.at(-1)!;
const securedHydration = generalWS.send('chats/list', {});
secured.open();
secured.receive({ type: 'push/connected', payload: { requires_auth: true } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(secured.sent.length, 1, 'A password-protected server must authenticate before hydration');
assert.equal(secured.sent[0].type, 'auth/login');
assert.equal(secured.sent[0].payload.password, 'test-password');
secured.receive({
  id: secured.sent[0].id,
  type: 'auth/login/response',
  payload: { session_token: 'secured-session' },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(generalWS.authenticated, true);
assert.equal(generalWS.sessionToken, 'secured-session');
assert.equal(confirmedPasswords.at(-1)?.endpoint, 'ws://secured.example:8468');
assert.equal(secured.sent[1].type, 'chats/list');
secured.receive({
  id: secured.sent[1].id,
  type: 'chats/list/response',
  payload: { providers: [] },
});
assert.deepEqual(await securedHydration, { providers: [] });

// A stale subordinate capability is renewed over the already-authenticated
// General WS without another password login. Requests arriving during the
// reconfirmation wait behind the same recovery promise.
const reconfirm = generalWS.ensureConnected({ reconfirm: true });
await Promise.resolve();
const proof = secured.sent.at(-1)!;
assert.equal(proof.type, 'client/proof-of-life');
const queuedBehindReconfirm = generalWS.send('runs/status', { chat_id: 'transport-audit' });
await Promise.resolve();
assert.equal(secured.sent.at(-1), proof, 'Normal requests must queue behind reconfirmation');
secured.receive({
  id: proof.id,
  type: 'client/proof-of-life/response',
  payload: { ok: true, session_token: 'refreshed-session' },
});
await reconfirm;
await new Promise((resolve) => setImmediate(resolve));
assert.equal(generalWS.sessionToken, 'refreshed-session');
const queued = secured.sent.at(-1)!;
assert.equal(queued.type, 'runs/status');
secured.receive({ id: queued.id, type: 'runs/status/response', payload: { ok: true } });
await queuedBehindReconfirm;

passwordQueue.push(
  { password: 'expired-password', remember: true, remembered: true },
  { password: 'replacement-password', remember: true, remembered: false },
);
setGeneralWSBaseUrl('ws://rotated.example:8468');
const rotated = MockSecureWebSocket.instances.at(-1)!;
rotated.open();
rotated.receive({ type: 'push/connected', payload: { requires_auth: true } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(rotated.sent[0]?.payload.password, 'expired-password');
assert.equal(confirmedPasswords.filter((entry) => entry.endpoint.includes('rotated')).length, 0,
  'Passwords must never be persisted before the server confirms authentication');
rotated.receive({
  id: rotated.sent[0].id,
  type: 'error',
  payload: { message: 'Invalid server password' },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(rejectedPasswords.at(-1)?.password, 'expired-password',
  'An outdated remembered password must be discarded before prompting manually');
assert.equal(rotated.sent[1]?.payload.password, 'replacement-password');
rotated.receive({
  id: rotated.sent[1].id,
  type: 'auth/login/response',
  payload: { session_token: 'rotated-session' },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(generalWS.authenticated, true);
assert.equal(confirmedPasswords.at(-1)?.password, 'replacement-password');
assert.equal(confirmedPasswords.at(-1)?.endpoint, 'ws://rotated.example:8468');

generalWS.disconnect();
console.log('Live secure WebSocket server handoff, concurrent hydration, remembered-password rotation, stale socket isolation, and handshake diagnostics verified.');
