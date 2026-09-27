import assert from 'node:assert/strict';

class MemoryStorage {
  data = new Map<string, string>();
  failWrites = false;
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('simulated storage failure');
    this.data.set(key, value);
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

const trust = await import('../src/app/services/harnessTrust.ts');
const identity = new Uint8Array(32).fill(7);

// Startup handshake may beat React mounting the dialog. It must wait rather
// than fail and incur reconnect backoff.
let settled = false;
const pending = trust.requireTrustedHarness('ws://localhost:8468/ws/general', identity)
  .then(() => { settled = true; });
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(settled, false);
let prompts = 0;
trust.setHarnessTrustHandler(async () => {
  prompts += 1;
  return { action: 'trust', remember: true };
});
await pending;
assert.equal(prompts, 1);
assert.ok(storage.getItem(trust.harnessPinKey('ws://localhost:8468/ws/general')));

// A persisted pin must bypass the dialog on later connections.
await trust.requireTrustedHarness('ws://localhost:8468/ws/general', identity);
assert.equal(prompts, 1);

// A requested remembered decision must not silently become session-only when
// persistent storage fails. Use a second endpoint/identity to avoid the first pin.
storage.failWrites = true;
const identity2 = new Uint8Array(32).fill(8);
await assert.rejects(
  trust.requireTrustedHarness('ws://localhost:9468/ws/general', identity2),
  /simulated storage failure/,
);
assert.equal(prompts, 2);

storage.failWrites = false;
await trust.requireTrustedHarness('ws://localhost:9468/ws/general', identity2);
assert.equal(prompts, 3, 'failed persistence must not leave a session pin behind');

console.log('harness trust regression: ok');
