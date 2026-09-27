/**
 * clientHttpRelay.ts — client-POV HTTP relay with real backpressure.
 *
 * Client-POV providers execute their HTTP request in this renderer and relay
 * the response to the Vulcan server. Streaming responses are flow controlled
 * by bytes, not by promises or message counts:
 *
 *   server advertises `flow.window_bytes`
 *   -> at most that many bytes may be sent but not yet consumed server-side
 *   -> the server returns `push/client-http-credit {bytes}` as its run consumes
 *   -> when the window is full the fetch reader *waits* before reading more,
 *      so the provider connection itself slows down.
 *
 * Each chunk carries `n`, its size in this client's own units; credits come
 * back in exactly those units, so JS/Python string-length differences can
 * never make the accounting drift.
 *
 * Servers without flow control get a bounded fallback: the reader waits while
 * more than LEGACY_UNSENT_LIMIT bytes are still queued for the local socket.
 */

export interface RelayTransport {
  push(type: string, payload: any): Promise<void>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const COALESCE_BYTES = 8 * 1024;
export const COALESCE_MS = 2;
export const LEGACY_UNSENT_LIMIT = 1024 * 1024;

interface RelayState {
  controller: AbortController;
  window: number | null;
  inflight: number;
  waiters: Array<() => void>;
  closed: boolean;
}

export class ClientHttpRelay {
  private readonly active = new Map<string, RelayState>();
  readonly stats = { peakInflight: 0, waits: 0 };

  private readonly transport: RelayTransport;
  private readonly fetchImpl: FetchLike;

  constructor(transport: RelayTransport, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.transport = transport;
    this.fetchImpl = fetchImpl;
  }

  get activeCount(): number { return this.active.size; }

  inflight(relayId: string): number { return this.active.get(relayId)?.inflight ?? 0; }

  private wake(state: RelayState): void {
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  handleCredit(payload: any): void {
    const state = this.active.get(String(payload?.relay_id || ''));
    if (!state) return;
    const bytes = Number(payload?.bytes) || 0;
    state.inflight = Math.max(0, state.inflight - bytes);
    this.wake(state);
  }

  handleCancel(payload: any): void {
    const state = this.active.get(String(payload?.relay_id || ''));
    if (!state) return;
    state.closed = true;
    state.controller.abort();
    this.wake(state);
  }

  abortAll(): void {
    for (const state of this.active.values()) {
      state.closed = true;
      state.controller.abort();
      this.wake(state);
    }
    this.active.clear();
  }

  private async waitForCapacity(state: RelayState): Promise<void> {
    const limit = state.window ?? LEGACY_UNSENT_LIMIT;
    while (!state.closed && state.inflight >= limit) {
      this.stats.waits += 1;
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
  }

  async handleRequest(payload: any): Promise<void> {
    const relayId = String(payload?.relay_id || '');
    if (!relayId) return;
    const windowBytes = Number(payload?.flow?.window_bytes);
    const state: RelayState = {
      controller: new AbortController(),
      window: Number.isFinite(windowBytes) && windowBytes > 0 ? windowBytes : null,
      inflight: 0,
      waiters: [],
      closed: false,
    };
    this.active.set(relayId, state);
    const timeoutMs = Math.max(1000, Number(payload?.timeout_ms || 30000));
    const timer = setTimeout(() => state.controller.abort(), timeoutMs);
    const emit = (event: Record<string, any>) =>
      this.transport.push('client/http-event', { relay_id: relayId, ...event });

    // Browser fetch may expose very small transport chunks. Coalesce only a
    // couple of milliseconds worth so AES/JSON/WebSocket framing overhead
    // stays low without making token streaming feel buffered.
    let buffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSend: Promise<void> = Promise.resolve();
    const flush = (): Promise<void> => {
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      if (!buffer) return lastSend;
      const data = buffer;
      const n = data.length;
      buffer = '';
      state.inflight += n;
      this.stats.peakInflight = Math.max(this.stats.peakInflight, state.inflight);
      const sent = this.transport.push('client/http-chunk', { relay_id: relayId, data, n });
      if (state.window === null) {
        // Legacy server: capacity returns once the chunk has left this client.
        void sent.then(() => { state.inflight = Math.max(0, state.inflight - n); this.wake(state); }, () => {});
      }
      lastSend = sent;
      return sent;
    };
    const emitChunk = (data: string) => {
      if (!data) return;
      buffer += data;
      if (buffer.length >= COALESCE_BYTES) {
        void flush().catch(() => {});
      } else if (flushTimer === null) {
        flushTimer = setTimeout(() => { void flush().catch(() => {}); }, COALESCE_MS);
      }
    };

    try {
      const response = await this.fetchImpl(String(payload.url || ''), {
        method: payload.method || 'GET',
        headers: payload.headers || {},
        body: payload.body == null || (payload.method || 'GET') === 'GET'
          ? undefined
          : (typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body)),
        signal: state.controller.signal,
        redirect: 'follow',
      });
      if (!payload.stream) {
        const text = await response.text();
        await emit({ event: 'response', status: response.status, headers: Object.fromEntries(response.headers.entries()), text });
        return;
      }
      await emit({ event: 'headers', status: response.status, headers: Object.fromEntries(response.headers.entries()) });
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          // Backpressure: do not pull more provider data while the relay
          // window is full. The unread body stays in the network stack.
          await this.waitForCapacity(state);
          if (state.closed) throw Object.assign(new Error('Client HTTP request cancelled'), { name: 'AbortError' });
          const { value, done } = await reader.read();
          if (done) break;
          const data = decoder.decode(value, { stream: true });
          if (data) emitChunk(data);
        }
        const tail = decoder.decode();
        if (tail) emitChunk(tail);
      }
      await flush();
      await emit({ event: 'done' });
    } catch (error: any) {
      const message = error?.name === 'AbortError' ? 'Client HTTP request cancelled' : (error?.message ?? String(error));
      await emit({ event: 'error', error: message }).catch(() => {});
    } finally {
      if (flushTimer !== null) clearTimeout(flushTimer);
      clearTimeout(timer);
      state.closed = true;
      this.wake(state);
      this.active.delete(relayId);
    }
  }
}
