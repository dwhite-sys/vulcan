/**
 * Authenticated encrypted WebSocket transport for Vulcan.
 *
 * Uses only Web Crypto: Ed25519 signatures, ephemeral X25519 key agreement,
 * HKDF-SHA256, and directional AES-256-GCM frame encryption. The server identity
 * is pinned per endpoint on first use and rejected if it changes later.
 */

import { requireTrustedHarness } from './harnessTrust';

const VERSION = 1;
const CONTEXT = new TextEncoder().encode('vulcan-secure-session-v1\0');
const KEY_BYTES = 32;

type JsonValue = any;

interface QueuedSend {
  payload: JsonValue;
  priority: number;
  order: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sequenceBytes(sequence: number): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid sequence');
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(sequence / 0x100000000), false);
  view.setUint32(4, sequence >>> 0, false);
  return out;
}

function nonce(prefix: Uint8Array, sequence: number): Uint8Array {
  if (prefix.length !== 4) throw new Error('Invalid nonce prefix');
  return concat(prefix, sequenceBytes(sequence));
}

function aad(sequence: number): Uint8Array {
  return concat(new TextEncoder().encode('vulcan-frame-v1\0'), sequenceBytes(sequence));
}

async function deriveDirectionalKeys(shared: ArrayBuffer, transcript: Uint8Array): Promise<{ c2s: CryptoKey; s2c: CryptoKey }> {
  const salt = await crypto.subtle.digest('SHA-256', transcript);
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const material = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info: new TextEncoder().encode('vulcan-secure-session-keys'),
  }, hkdfKey, 64 * 8);
  const bytes = new Uint8Array(material);
  const c2s = await crypto.subtle.importKey('raw', bytes.slice(0, KEY_BYTES), 'AES-GCM', false, ['encrypt']);
  const s2c = await crypto.subtle.importKey('raw', bytes.slice(KEY_BYTES), 'AES-GCM', false, ['decrypt']);
  bytes.fill(0);
  return { c2s, s2c };
}

export class SecureWebSocket {
  private readonly ws: WebSocket;
  private sendKey: CryptoKey | null = null;
  private receiveKey: CryptoKey | null = null;
  private sendPrefix: Uint8Array | null = null;
  private receivePrefix: Uint8Array | null = null;
  private sendSequence = 0;
  private receiveSequence = 0;
  private ready = false;
  // Web Crypto operations are asynchronous. Outbound application messages are
  // therefore serialized through one priority queue: sequence numbers remain
  // strict, while tiny RPC/control frames can overtake provider/bulk work that
  // has not yet been handed to the browser socket.
  private sendQueue: QueuedSend[] = [];
  private sendOrder = 0;
  private sendPump: Promise<void> | null = null;
  private receiveChain: Promise<void> = Promise.resolve();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  onopen?: () => void;
  onmessage?: (payload: JsonValue) => void;
  onclose?: (event: CloseEvent) => void;
  onerror?: (error: Error) => void;

  constructor(private readonly url: string) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ws = new WebSocket(url);
    this.ws.onmessage = (event) => {
      this.receiveChain = this.receiveChain
        .then(() => this.handleRawMessage(event.data))
        .catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    };
    this.ws.onclose = (event) => {
      if (!this.ready) this.rejectReady(new Error('WebSocket closed during secure handshake'));
      this.rejectQueuedSends(new Error('Secure WebSocket disconnected'));
      this.clearKeys();
      this.onclose?.(event);
    };
    this.ws.onerror = () => {
      const error = new Error('Secure WebSocket transport error');
      if (!this.ready) this.rejectReady(error);
      this.onerror?.(error);
    };
  }

  get connected(): boolean {
    return this.ready && this.ws.readyState === WebSocket.OPEN;
  }

  async waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  send(payload: JsonValue, priority = 3): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sendQueue.push({ payload, priority, order: ++this.sendOrder, resolve, reject });
      this.startSendPump();
    });
  }

  private startSendPump(): void {
    if (this.sendPump) return;
    const pump = this.drainSendQueue();
    this.sendPump = pump;
    void pump.finally(() => {
      if (this.sendPump === pump) this.sendPump = null;
      if (this.sendQueue.length) this.startSendPump();
    });
  }

  private async drainSendQueue(): Promise<void> {
    while (this.sendQueue.length) {
      this.sendQueue.sort((a, b) => a.priority - b.priority || a.order - b.order);
      const item = this.sendQueue.shift()!;
      try {
        await this.sendOrdered(item.payload, item.priority);
        item.resolve();
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async sendOrdered(payload: JsonValue, priority: number): Promise<void> {
    await this.readyPromise;
    if (!this.sendKey || !this.sendPrefix || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Secure WebSocket is not connected');
    }
    await this.waitForSocketCapacity(priority);
    const sequence = this.sendSequence;
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce(this.sendPrefix, sequence),
      additionalData: aad(sequence),
      tagLength: 128,
    }, this.sendKey, plaintext);
    this.ws.send(JSON.stringify({
      type: 'secure',
      sequence,
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    }));
    this.sendSequence += 1;
  }

  private async waitForSocketCapacity(priority: number): Promise<void> {
    // Provider relay/control frames are latency-sensitive, but letting ws.send()
    // enqueue an unbounded amount of encrypted text only moves the queue into the
    // browser where Vulcan can no longer prioritize it. Reserve headroom for
    // priority 0/1 traffic and apply firmer backpressure to lower-priority work.
    const highWater = priority <= 1 ? 4 * 1024 * 1024 : 768 * 1024;
    const lowWater = priority <= 1 ? 2 * 1024 * 1024 : 256 * 1024;
    if (this.ws.bufferedAmount <= highWater) return;
    while (this.ws.bufferedAmount > lowWater) {
      if (this.ws.readyState !== WebSocket.OPEN) throw new Error('Secure WebSocket disconnected');
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }

  private rejectQueuedSends(error: Error): void {
    const queued = this.sendQueue.splice(0);
    for (const item of queued) item.reject(error);
  }

  close(code?: number, reason?: string): void {
    this.rejectQueuedSends(new Error('Secure WebSocket closed'));
    this.ws.close(code, reason);
    this.clearKeys();
  }

  private async handleRawMessage(raw: unknown): Promise<void> {
    if (typeof raw !== 'string') return this.fail(new Error('Binary plaintext frame rejected'));

    let message: any;
    try { message = JSON.parse(raw); }
    catch { return this.fail(new Error('Invalid WebSocket JSON frame')); }

    if (!this.ready) {
      try {
        if (message.type === 'handshake/server') {
          await this.handleServerHello(message);
          return;
        }
        if (message.type === 'handshake/ready') {
          if (!this.sendKey || !this.receiveKey) throw new Error('Handshake ready before key derivation');
          this.ready = true;
          this.resolveReady();
          this.onopen?.();
          return;
        }
        if (message.type === 'handshake/error') throw new Error(message.message ?? 'Secure handshake rejected');
        throw new Error('Unexpected plaintext frame before secure handshake completed');
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    try {
      if (message.type !== 'secure') throw new Error('Plaintext application frame rejected');
      const sequence = Number(message.sequence);
      if (sequence !== this.receiveSequence) {
        throw new Error(`Unexpected secure frame sequence ${sequence}; expected ${this.receiveSequence}`);
      }
      if (!this.receiveKey || !this.receivePrefix) throw new Error('Missing receive key');
      const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: nonce(this.receivePrefix, sequence),
        additionalData: aad(sequence),
        tagLength: 128,
      }, this.receiveKey, base64ToBytes(message.ciphertext));
      this.receiveSequence += 1;
      this.onmessage?.(JSON.parse(new TextDecoder().decode(plaintext)));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleServerHello(message: any): Promise<void> {
    if (Number(message.version) !== VERSION) throw new Error('Unsupported Vulcan secure-session version');
    const identity = base64ToBytes(message.identity);
    const serverEphemeral = base64ToBytes(message.ephemeral);
    const signature = base64ToBytes(message.signature);
    const serverPrefix = base64ToBytes(message.send_prefix);
    if (identity.length !== 32 || serverEphemeral.length !== 32 || serverPrefix.length !== 4) {
      throw new Error('Invalid server handshake key material');
    }

    const identityKey = await crypto.subtle.importKey('raw', identity, { name: 'Ed25519' }, false, ['verify']);
    const verified = await crypto.subtle.verify(
      { name: 'Ed25519' }, identityKey, signature, concat(CONTEXT, serverEphemeral, serverPrefix),
    );
    if (!verified) throw new Error('Invalid Vulcan server handshake signature');
    await requireTrustedHarness(this.url, identity);

    const clientPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const clientPublic = new Uint8Array(await crypto.subtle.exportKey('raw', clientPair.publicKey));
    const serverPublicKey = await crypto.subtle.importKey('raw', serverEphemeral, { name: 'X25519' }, false, []);
    const shared = await crypto.subtle.deriveBits({
      name: 'X25519', public: serverPublicKey,
    }, clientPair.privateKey, 256);
    const clientPrefix = crypto.getRandomValues(new Uint8Array(4));
    const transcript = concat(
      CONTEXT, identity, serverEphemeral, clientPublic, serverPrefix, clientPrefix,
    );
    const keys = await deriveDirectionalKeys(shared, transcript);
    this.sendKey = keys.c2s;
    this.receiveKey = keys.s2c;
    this.sendPrefix = clientPrefix;
    this.receivePrefix = serverPrefix;

    this.ws.send(JSON.stringify({
      type: 'handshake/client',
      version: VERSION,
      ephemeral: bytesToBase64(clientPublic),
      send_prefix: bytesToBase64(clientPrefix),
    }));
  }

  private fail(error: Error): void {
    if (!this.ready) this.rejectReady(error);
    this.onerror?.(error);
    try { this.ws.close(1002, 'Secure session failure'); } catch { /* ignore */ }
    this.clearKeys();
  }

  private clearKeys(): void {
    this.sendKey = null;
    this.receiveKey = null;
    this.sendPrefix?.fill(0);
    this.receivePrefix?.fill(0);
    this.sendPrefix = null;
    this.receivePrefix = null;
    this.ready = false;
  }
}
