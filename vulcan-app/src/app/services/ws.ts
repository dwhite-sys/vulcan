/**
 * ws.ts — WebSocket client manager
 *
 * Manages authenticated encrypted WebSocket connections to the Vulcan server:
 *   - General WS (/ws/general): all request/response operations
 *   - Terminal WS (/ws/terminal/{chat_id}/{kind}/{slot}): per-slot PTY streaming
 *
 * General WS:
 *   - Performs an authenticated ephemeral key exchange on every connection
 *   - Encrypts every application frame after the handshake
 *   - Connects on startup, auto-reconnects with exponential backoff
 *   - Authenticates if server requires a password
 *   - All outbound messages get a UUID, pending promises resolve/reject on response
 *
 * Terminal WS:
 *   - One connection per active terminal slot, managed separately
 *   - See TerminalSlotWidget.tsx for usage
 */


import { SecureWebSocket } from './secureWebSocket';
import { requestServerPassword } from './serverPasswordPrompt';
import { getVulcanWsBaseUrl } from './vulcanEndpoint';
const RECONNECT_BASE  = 500;   // ms
const RECONNECT_MAX   = 10000; // ms
const REQUEST_TIMEOUT = 30000; // ms

type MessageHandler = (payload: any) => void;

interface PendingRequest {
  resolve: (payload: any) => void;
  reject:  (error: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}


// ── General WebSocket ─────────────────────────────────────────────────────────

class GeneralWSClient {
  private ws:         SecureWebSocket | null = null;
  private pending:    Map<string, PendingRequest> = new Map();
  private pushHandlers: Map<string, MessageHandler[]> = new Map();
  private reconnectDelay = RECONNECT_BASE;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private baseUrl:    string;
  private _connected  = false;
  private _requiresAuth = false;
  private _authenticated = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;

  // Callbacks
  onConnected?: (requiresAuth: boolean) => void;
  onDisconnected?: () => void;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  get connected() { return this._connected; }
  get authenticated() { return this._authenticated; }
  get requiresAuth() { return this._requiresAuth; }

  setBaseUrl(baseUrl: string) {
    if (this.baseUrl === baseUrl) return;
    this.disconnect();
    this.baseUrl = baseUrl;
    this.connect();
  }

  connect() {
    if (this.ws?.connected) return;
    try {
      this.ws = new SecureWebSocket(`${this.baseUrl}/ws/general`);
      this.ws.onopen    = () => this._onOpen();
      this.ws.onmessage = (msg) => this._onMessage(msg);
      this.ws.onclose   = (e) => this._onClose(e);
      this.ws.onerror   = () => {};  // onclose fires after onerror
    } catch {
      this._scheduleReconnect();
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this._authenticated = false;
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  private _onOpen() {
    this.reconnectDelay = RECONNECT_BASE;
    // Wait for push/connected which tells us if auth is required
  }

  private async _onMessage(msg: any) {
    const { id, type, payload } = msg;

    // Server-push messages
    if (type === 'push/connected') {
      this._requiresAuth = !!payload?.requires_auth;
      this._connected = true;

      if (this._requiresAuth) {
        // The server advertises requires_auth only when an Argon2id password
        // hash exists. Prompt only in that case, and never persist plaintext.
        let authError: string | undefined;
        while (!this._authenticated) {
          let pwd: string;
          try {
            pwd = await requestServerPassword({ endpoint: this.baseUrl, error: authError });
          } catch {
            this.ws?.close();
            this.resolveReady();
            return;
          }

          try {
            await this._send('auth/login', { password: pwd });
            this._authenticated = true;
          } catch (error: any) {
            authError = error?.message ?? 'Invalid server password';
          } finally {
            // JavaScript strings cannot be zeroed reliably; drop the reference
            // immediately and do not retain or persist the password.
            pwd = '';
          }
        }
      } else {
        this._authenticated = true;
      }

      this.resolveReady();
      this.onConnected?.(this._requiresAuth);
      return;
    }

    if (type?.startsWith('push/')) {
      const handlers = this.pushHandlers.get(type) ?? [];
      handlers.forEach((h) => h(payload));
      return;
    }

    // Request/response correlation
    if (id) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (type === 'error') {
          pending.reject(new Error(payload?.message ?? 'Unknown error'));
        } else {
          pending.resolve(payload);
        }
      }
    }
  }

  private _onClose(e: CloseEvent) {
    this._connected = false;
    this._authenticated = false;
    this.resolveReady();

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebSocket disconnected'));
    }
    this.pending.clear();

    this.onDisconnected?.();
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
    this._scheduleReconnect();
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX);
  }

  /** Send a request, return a promise that resolves with the response payload. */
  async send(type: string, payload: any = {}): Promise<any> {
    // Requests made while the secure connection or optional password prompt is
    // still completing wait for that process instead of leaking a vague
    // "Not authenticated" error into model-visible tool output.
    if (!this._authenticated) await this.readyPromise;
    if (!this._authenticated) {
      if (this._requiresAuth) {
        throw new Error('Harness authentication was not completed. Enter the server password in Vulcan and try again.');
      }
      throw new Error('Vulcan secure connection is not ready. Please wait a moment and try again.');
    }
    return this._send(type, payload);
  }

  private async _send(type: string, payload: any = {}): Promise<any> {
    if (!this.ws?.connected) {
      throw new Error('Secure WebSocket not connected');
    }
    const id = crypto.randomUUID();
    const msg = { id, type, payload };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${type}`));
      }, REQUEST_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });
      void this.ws!.send(msg).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  /** Register a handler for server-push messages. */
  onPush(type: string, handler: MessageHandler) {
    const existing = this.pushHandlers.get(type) ?? [];
    this.pushHandlers.set(type, [...existing, handler]);
    return () => {
      const handlers = this.pushHandlers.get(type) ?? [];
      this.pushHandlers.set(type, handlers.filter((h) => h !== handler));
    };
  }
}


// ── Singleton ─────────────────────────────────────────────────────────────────

export const generalWS = new GeneralWSClient(getVulcanWsBaseUrl());

export function setGeneralWSBaseUrl(baseUrl: string) {
  generalWS.setBaseUrl(baseUrl);
}

/** Convenience wrapper — send a message and return the payload. */
export async function wsRequest<T = any>(type: string, payload: any = {}): Promise<T> {
  return generalWS.send(type, payload) as Promise<T>;
}

/** Connect on module load. */
generalWS.connect();
