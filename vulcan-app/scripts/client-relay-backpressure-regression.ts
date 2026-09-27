import assert from 'node:assert/strict';
import { ClientHttpRelay, COALESCE_BYTES, LEGACY_UNSENT_LIMIT } from '../src/app/services/clientHttpRelay.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHUNK = 4096;

function providerStream(totalChunks: number, pulled: { bytes: number }) {
  let sent = 0;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalChunks) { controller.close(); return; }
      const body = `data: ${String(sent).padStart(6, '0')}${'x'.repeat(CHUNK - 13)}\n`;
      sent += 1;
      pulled.bytes += body.length;
      controller.enqueue(encoder.encode(body));
    },
  }, { highWaterMark: 1 });
}

function fakeFetch(stream: ReadableStream<Uint8Array>) {
  return async (_url: string, init: RequestInit) => {
    init.signal?.addEventListener('abort', () => { void stream.cancel().catch(() => {}); });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

// 1. With a server window, the provider is only read as fast as credit returns.
{
  const window = 64 * 1024;
  const pulled = { bytes: 0 };
  const chunks: Array<{ data: string; n: number }> = [];
  const events: string[] = [];
  const relay = new ClientHttpRelay({
    push: async (type, payload) => {
      if (type === 'client/http-chunk') chunks.push(payload);
      else events.push(payload.event);
    },
  }, fakeFetch(providerStream(400, pulled)) as any);
  const done = relay.handleRequest({
    relay_id: 'r1', url: 'http://provider/v1/chat/completions', method: 'POST', body: {}, stream: true,
    timeout_ms: 60_000, flow: { window_bytes: window },
  });
  await sleep(100);
  const sentBytes = chunks.reduce((sum, chunk) => sum + chunk.n, 0);
  // Bounded: the window plus one coalesced frame and the stream's own buffer.
  assert.ok(relay.inflight('r1') <= window + COALESCE_BYTES + CHUNK, `inflight ${relay.inflight('r1')}`);
  assert.ok(pulled.bytes <= window + COALESCE_BYTES + 3 * CHUNK, `reader pulled ${pulled.bytes} bytes without credit`);
  assert.ok(sentBytes < 400 * CHUNK / 2, 'relay must stall without credit');
  assert.ok(relay.stats.waits > 0);
  // The server consumes and returns credit; the stream completes, in order.
  let credited = 0;
  while (!events.includes('done')) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.n, 0);
    if (total > credited) {
      relay.handleCredit({ relay_id: 'r1', bytes: total - credited });
      credited = total;
    }
    await sleep(2);
  }
  await done;
  const body = chunks.map((chunk) => chunk.data).join('');
  assert.equal(body.length, 400 * CHUNK);
  const order = [...body.matchAll(/data: (\d{6})/g)].map((match) => Number(match[1]));
  assert.deepEqual(order, Array.from({ length: 400 }, (_, index) => index));
  assert.ok(relay.stats.peakInflight <= window + COALESCE_BYTES + CHUNK);
  assert.equal(relay.activeCount, 0);
}

// 2. Cancel releases a relay that is blocked on a full window.
{
  const events: any[] = [];
  const relay = new ClientHttpRelay({
    push: async (type, payload) => { if (type === 'client/http-event') events.push(payload); },
  }, fakeFetch(providerStream(1000, { bytes: 0 })) as any);
  const done = relay.handleRequest({
    relay_id: 'r2', url: 'http://provider', method: 'POST', body: {}, stream: true,
    timeout_ms: 60_000, flow: { window_bytes: 16 * 1024 },
  });
  await sleep(50);
  relay.handleCancel({ relay_id: 'r2' });
  await Promise.race([done, sleep(1000).then(() => { throw new Error('cancel did not release blocked relay'); })]);
  assert.equal(events.at(-1).event, 'error');
  assert.match(events.at(-1).error, /cancelled/);
}

// 3. Servers without credits still get a bounded client backlog.
{
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pulled = { bytes: 0 };
  const events: string[] = [];
  const relay = new ClientHttpRelay({
    push: async (type, payload) => {
      if (type === 'client/http-chunk') await gate; // socket backed up
      else events.push(payload.event);
    },
  }, fakeFetch(providerStream(1000, pulled)) as any);
  const done = relay.handleRequest({
    relay_id: 'r3', url: 'http://provider', method: 'POST', body: {}, stream: true, timeout_ms: 60_000,
  });
  await sleep(150);
  assert.ok(pulled.bytes <= LEGACY_UNSENT_LIMIT + COALESCE_BYTES + 3 * CHUNK, `legacy reader pulled ${pulled.bytes}`);
  release!();
  await done;
  assert.ok(events.includes('done'));
}

console.log('Client relay backpressure regression: ok');
