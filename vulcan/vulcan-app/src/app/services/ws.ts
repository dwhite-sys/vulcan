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
import {
  confirmServerPassword,
  rejectServerPassword,
  requestServerPassword,
  type ServerPasswordCredentials,
} from './serverPasswordPrompt';
import { getVulcanWsBaseUrl } from './vulcanEndpoint';
const RECONNECT_BASE  = 500;   // ms
const RECONNECT_MAX   = 10000; // ms
const REQUEST_TIMEOUT = 30000; // ms
const RECOVERY_TIMEOUT = 10000; // ms; connection recovery itself, not ordinary requests

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
  private connectionHandlers = new Set<(connected: boolean) => void>();
  private sessionTokenHandlers = new Set<(token: string | null) => void>();
  private reconnectDelay = RECONNECT_BASE;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private baseUrl:    string;
  private _connected  = false;
  private _requiresAuth = false;
  private _authenticated = false;
  private _sessionToken: string | null = null;
  private connectionGeneration = 0;
  private lastConnectionError: Error | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private recoveryPromise: Promise<void> | null = null;
  private recoveryGeneration = -1;

  // Callbacks
  onConnected?: (requiresAuth: boolean) => void;
  onDisconnected?: () => void;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.readyPromise = this._createReadyPromise();
  }

  private _createReadyPromise(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // The singleton connects before any consumer necessarily starts waiting.
    // Preserve the rejection for future awaiters without creating an unhandled
    // rejection when a handshake fails before hydration begins.
    void ready.catch(() => {});
    return ready;
  }

  get connected() { return this._connected; }
  get authenticated() { return this._authenticated; }
  get requiresAuth() { return this._requiresAuth; }
  get sessionToken() { return this._sessionToken; }

  /** Observe usable, authenticated Vulcan connections independently of Etna. */
  onConnectionChange(handler: (connected: boolean) => void) {
    this.connectionHandlers.add(handler);
    handler(this._connected && this._authenticated);
    return () => { this.connectionHandlers.delete(handler); };
  }

  private _notifyConnectionChange() {
    const connected = this._connected && this._authenticated;
    this.connectionHandlers.forEach((handler) => handler(connected));
  }

  onSessionTokenChange(handler: (token: string | null) => void) {
    this.sessionTokenHandlers.add(handler);
    handler(this._sessionToken);
    return () => { this.sessionTokenHandlers.delete(handler); };
  }

  private _setSessionToken(token: string | null) {
    if (this._sessionToken === token) return;
    this._sessionToken = token;
    this.sessionTokenHandlers.forEach((handler) => handler(token));
  }

  setBaseUrl(baseUrl: string) {
    if (this.baseUrl === baseUrl) return;
    this.disconnect(new Error('Vulcan server changed while waiting for its secure connection.'));
    this.baseUrl = baseUrl;
    this.reconnectDelay = RECONNECT_BASE;
    this.connect();
  }

  connect() {
    if (this.ws) return;
    try {
      const generation = this.connectionGeneration;
      const socket = new SecureWebSocket(`${this.baseUrl}/ws/general`);
      this.ws = socket;
      this.lastConnectionError = null;
      socket.onopen    = () => { if (this.ws === socket) this._onOpen(); };
      socket.onmessage = (msg) => {
        if (this.ws === socket) void this._onMessage(msg, socket, generation);
      };
      socket.onclose   = (e) => { if (this.ws === socket) this._onClose(e); };
      socket.onerror   = (error) => {
        if (this.ws === socket) this.lastConnectionError = error;
      };
    } catch (error) {
      this.lastConnectionError = error instanceof Error ? error : new Error(String(error));
      this._scheduleReconnect();
    }
  }

  disconnect(reason = new Error('WebSocket disconnected')) {
    this.connectionGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const previousSocket = this.ws;
    this.ws = null;
    previousSocket?.close();
    this._connected = false;
    this._authenticated = false;
    this._requiresAuth = false;
    this._setSessionToken(null);
    this.lastConnectionError = null;
    this._notifyConnectionChange();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
    this.rejectReady(reason);
    this.readyPromise = this._createReadyPromise();
  }

  private _onOpen() {
    this.reconnectDelay = RECONNECT_BASE;
    // Wait for push/connected which tells us if auth is required
  }

  private async _onMessage(msg: any, socket: SecureWebSocket, generation: number) {
    const { id, type, payload } = msg;

    // Server-push messages
    if (type === 'push/connected') {
      this._requiresAuth = !!payload?.requires_auth;
      this._connected = true;

      if (this._requiresAuth) {
        // The server advertises requires_auth only when an Argon2id password
        // hash exists. Credentials are remembered only through native secure
        // storage, only per endpoint, and only after a successful server login.
        let authError: string | undefined;
        while (!this._authenticated) {
          let credentials: ServerPasswordCredentials;
          try {
            credentials = await requestServerPassword({ endpoint: this.baseUrl, error: authError });
          } catch {
            if (this.ws !== socket || generation !== this.connectionGeneration) return;
            this.lastConnectionError = new Error(
              'Harness authentication was not completed. Enter the server password in Vulcan and try again.',
            );
            socket.close();
            return;
          }

          try {
            if (this.ws !== socket || generation !== this.connectionGeneration) return;
            const response = await this._send('auth/login', { password: credentials.password });
            if (this.ws !== socket || generation !== this.connectionGeneration) return;
            await confirmServerPassword(this.baseUrl, credentials);
            if (this.ws !== socket || generation !== this.connectionGeneration) return;
            this._setSessionToken(typeof response?.session_token === 'string' ? response.session_token : null);
            this._authenticated = true;
          } catch (error: any) {
            if (this.ws !== socket || generation !== this.connectionGeneration) return;
            await rejectServerPassword(this.baseUrl, credentials);
            if (this.ws !== socket || generation !== this.connectionGeneration) return;
            authError = error?.message ?? 'Invalid server password';
          } finally {
            // JavaScript strings cannot be zeroed reliably; drop the reference
            // immediately; persistence, when opted in, is native and encrypted.
            credentials!.password = '';
          }
        }
      } else {
        this._authenticated = true;
      }

      if (this.ws !== socket || generation !== this.connectionGeneration) return;
      this.resolveReady();
      this._notifyConnectionChange();
      this.onConnected?.(this._requiresAuth);
      // Subscribers use the authenticated reconnect event to restore background
      // run subscriptions without coupling a run to this particular socket.
      (this.pushHandlers.get('push/connected') ?? []).forEach((handler) => handler(payload));
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
    const wasAuthenticated = this._authenticated;
    const connectionError = this.lastConnectionError;
    this.ws = null;
    this.lastConnectionError = null;
    this._connected = false;
    this._authenticated = false;
    this._setSessionToken(null);
    this._notifyConnectionChange();
    if (!wasAuthenticated) {
      this.rejectReady(connectionError ?? new Error(
        `Vulcan secure WebSocket closed before the connection was ready (code ${e.code}).`,
      ));
    }

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebSocket disconnected'));
    }
    this.pending.clear();

    this.onDisconnected?.();
    this.readyPromise = this._createReadyPromise();
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

  /**
   * Make the authenticated General WS usable, serializing recovery behind one
   * promise.  Callers that arrive during reconnect/reconfirmation naturally
   * queue by awaiting the same promise instead of racing independent handshakes.
   *
   * `reconfirm` is intentionally cheap: when the secure General WS survived,
   * it is one encrypted request/response which refreshes the subordinate token
   * without re-running password hashing.  If the socket died, the ordinary
   * SecureWebSocket reconnect/auth path runs first.
   */
  async ensureConnected(options: { reconfirm?: boolean } = {}): Promise<void> {
    const generation = this.connectionGeneration;
    // A reconfirmation already in flight is the debounce/queue barrier: normal
    // user/model requests wait behind it rather than observing half-refreshed
    // auth state. Recovery from an older server generation is never reused.
    if (this.recoveryPromise && this.recoveryGeneration === generation) return this.recoveryPromise;
    if (this._authenticated && this.ws?.connected && !options.reconfirm) return;

    this.recoveryGeneration = generation;
    const recovery = (async () => {
      if (!this.ws) this.connect();

      if (!this._authenticated || !this.ws?.connected) {
        await Promise.race([
          this.readyPromise,
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error('Timed out restoring the Vulcan secure connection.')),
            RECOVERY_TIMEOUT,
          )),
        ]);
      }

      if (generation !== this.connectionGeneration) {
        throw new Error('Vulcan server changed while restoring its secure connection.');
      }
      if (!this._authenticated || !this.ws?.connected) {
        throw new Error('Vulcan secure connection is not ready.');
      }

      if (options.reconfirm) {
        const response = await this._send('client/proof-of-life', {});
        if (this._requiresAuth) {
          const token = typeof response?.session_token === 'string' ? response.session_token : null;
          if (!token) throw new Error('Vulcan session reconfirmation did not return a capability token.');
          this._setSessionToken(token);
        }
      }
    })();
    this.recoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      // A server switch may already have installed a newer recovery promise.
      // Never let completion of the stale generation clear the new barrier.
      if (this.recoveryPromise === recovery) {
        this.recoveryPromise = null;
        this.recoveryGeneration = -1;
      }
    }
  }

  /** Send a request, return a promise that resolves with the response payload. */
  async send(type: string, payload: any = {}): Promise<any> {
    const generation = this.connectionGeneration;
    // Every ordinary request shares the same recovery barrier. Lifecycle hooks
    // normally repair the connection proactively; this keeps correctness when a
    // platform misses a lifecycle event or the network disappears independently.
    await this.ensureConnected();
    if (generation !== this.connectionGeneration) {
      throw new Error('Vulcan server changed while waiting for its secure connection.');
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
      // Keep provider dispatch/control ahead of bulk/background RPC. A huge
      // workspace listing or semantic-cache request must not delay runs/start.
      const priority = this.requestPriority(type);
      void this.ws!.send(msg, priority).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }


  private requestPriority(type: string): number {
    if (type === 'runs/start' || type === 'runs/cancel' || type === 'client/proof-of-life') return 0;
    if (type === 'workspace/path' || type === 'terminal/slots' || type === 'runs/status' || type === 'runs/answer') return 1;
    if (type === 'chats/upsert' || type === 'semantic/embed') return 7;
    if (type === 'workspace/list-files' || type === 'chats/list' || type === 'transcript/search') return 8;
    return 3;
  }

  /** Send an ordered one-way message. Unlike send(), this does not allocate a
   * request id/pending promise or wait for a server acknowledgement. Use only
   * for stream data where the surrounding control messages establish lifecycle. */
  async push(type: string, payload: any = {}): Promise<void> {
    const generation = this.connectionGeneration;
    await this.ensureConnected();
    if (generation !== this.connectionGeneration) {
      throw new Error('Vulcan server changed while waiting for its secure connection.');
    }
    if (!this.ws?.connected) throw new Error('Secure WebSocket not connected');
    const priority = type === 'client/http-event' || type === 'client/http-chunk'
      || type === 'etna/http-response' || type === 'design/action-response'
      ? 1
      : 3;
    await this.ws.send({ type, payload }, priority);
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
