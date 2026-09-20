/**
 * TerminalSlotWidget
 *
 * A single fully interactive terminal slot for either the agent or user.
 * Manages its own xterm instance and encrypted PTY WebSocket connection,
 * and scrollback serialization for app-restart persistence.
 */

import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import type { SlotKind } from '../types/vulcan';
import * as vulcanClient from '../services/vulcan';
import { SecureWebSocket } from '../services/secureWebSocket';
import { getVulcanBaseUrl, getVulcanWsBaseUrl } from '../services/vulcanEndpoint';


const VSCODE_THEME = {
  background:          '#1e1e1e',
  foreground:          '#cccccc',
  cursor:              '#aeafad',
  cursorAccent:        '#000000',
  selectionBackground: 'rgba(255,255,255,0.25)',
  black:               '#000000',
  red:                 '#cd3131',
  green:               '#0dbc79',
  yellow:              '#e5e510',
  blue:                '#2472c8',
  magenta:             '#bc3fbc',
  cyan:                '#11a8cd',
  white:               '#e5e5e5',
  brightBlack:         '#666666',
  brightRed:           '#f14c4c',
  brightGreen:         '#23d18b',
  brightYellow:        '#f5f543',
  brightBlue:          '#3b8eea',
  brightMagenta:       '#d670d6',
  brightCyan:          '#29b8db',
  brightWhite:         '#e5e5e5',
};

// Agent terminals use a slightly tinted background to distinguish them
const AGENT_THEME = {
  ...VSCODE_THEME,
  background: '#1a1e24',
};

export interface TerminalSlotWidgetProps {
  chatId: string;
  kind: SlotKind;
  slot: number;
  onStatusChange?: (status: 'connected' | 'disconnected' | 'closed-inactivity') => void;
}

export function TerminalSlotWidget({ chatId, kind, slot, onStatusChange }: TerminalSlotWidgetProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const xtermRef       = useRef<XTerm | null>(null);
  const fitAddonRef    = useRef<FitAddon | null>(null);
  const fitTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef          = useRef<SecureWebSocket | null>(null);
  const cleanupRef     = useRef<(() => void) | null>(null);
  const serverSwitchingRef = useRef(false);

  const debouncedFit = useCallback(() => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
    fitTimerRef.current = setTimeout(() => {
      try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
    }, 100);
  }, []);

  // A terminal belongs to its server. Disconnect before the general connection
  // changes, and never write old-server scrollback into the new server.
  useEffect(() => {
    const disconnectForServerSwitch = () => {
      serverSwitchingRef.current = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    window.addEventListener('vulcan:server-switching', disconnectForServerSwitch);
    return () => window.removeEventListener('vulcan:server-switching', disconnectForServerSwitch);
  }, []);

  // ── Init xterm once ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || xtermRef.current) return;

    const theme = kind === 'agent' ? AGENT_THEME : VSCODE_THEME;

    const term = new XTerm({
      theme,
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize:   13,
      lineHeight: 1.2,
      cursorBlink:  true,
      cursorStyle:  'block',
      scrollback:   5000,
      convertEol:   true,
      // Both user and agent terminals accept direct user input.
      disableStdin: false,
    });

    const fitAddon      = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);

    xtermRef.current    = term;
    fitAddonRef.current = fitAddon;

    term.onResize(({ cols, rows }) => {
      if (wsRef.current?.connected) {
        void wsRef.current.send({ type: 'resize', cols, rows }).catch(() => {});
      }
    });

    // Ctrl+Shift+C — copy selection
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
          return false;
        }
      }
      return true;
    });

    // User terminal input is handled in the connect effect via WS
    // (Re-attached on each connect to use the current WS instance)

    const ro = new ResizeObserver(() => debouncedFit());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
      cleanupRef.current?.();
      term.dispose();
      xtermRef.current    = null;
      fitAddonRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Connect to slot PTY via WebSocket ────────────────────────────────────────
  useEffect(() => {
    if (!chatId) return;

    cleanupRef.current?.();
    cleanupRef.current = null;
    let cancelled = false;
    let ws: SecureWebSocket | null = null;
    let inputDisposable: { dispose(): void } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    let terminalClosed = false;
    let pendingInput = '';
    let revivalPromise: Promise<void> | null = null;
    let authRecoveryPromise: Promise<void> | null = null;
    serverSwitchingRef.current = false;

    const scheduleReconnect = () => {
      if (cancelled || terminalClosed || serverSwitchingRef.current || authRecoveryPromise || reconnectTimer) return;
      const delay = Math.min(500 * 2 ** reconnectAttempts++, 5000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!cancelled && !serverSwitchingRef.current) void connect();
      }, delay);
    };

    const connect = async () => {
      inputDisposable?.dispose();
      inputDisposable = null;
      if (cancelled) return;
      // Fit before attaching. The open handshake carries this geometry so a new
      // PTY is born at the visible size and an existing PTY is resized before
      // the server replays its authoritative snapshot.
      try { fitAddonRef.current?.fit(); } catch { /* container may be between layouts */ }
      // Server snapshots are authoritative. reset() drops all prior xterm state,
      // including the current prompt line that clear() intentionally preserves.
      xtermRef.current?.reset();

      // Open WebSocket to terminal slot
      const wsUrl = vulcanClient.slotStreamUrl(chatId, kind, slot);
      ws = new SecureWebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws?.close(); return; }
        const term = xtermRef.current;
        void ws!.send({
          type: 'open',
          session_token: vulcanClient.generalWS.sessionToken,
          cols: term?.cols ?? 80,
          rows: term?.rows ?? 24,
        }).catch(() => ws?.close());
      };

      ws.onmessage = (msg) => {
        if (cancelled) { ws?.close(); return; }
        try {
          if (msg.type === 'scrollback' && xtermRef.current) {
            xtermRef.current.write(msg.data);
          } else if (msg.type === 'chunk' && xtermRef.current) {
            xtermRef.current.write(msg.data);
          } else if (msg.type === 'status') {
            if (msg.connected) {
              reconnectAttempts = 0;
              if (pendingInput && ws?.connected) {
                const buffered = pendingInput;
                pendingInput = '';
                void ws.send({ type: 'input', text: buffered }).catch(() => {
                  pendingInput = buffered + pendingInput;
                });
              }
            }
            onStatusChange?.(msg.connected ? 'connected' : 'disconnected');
          } else if (msg.type === 'closed') {
            terminalClosed = true;
            onStatusChange?.(msg.reason === 'inactivity' ? 'closed-inactivity' : 'disconnected');
            ws?.close();
          } else if (msg.type === 'error' && msg.code === 'auth_stale') {
            // A sleeping/backgrounded client can outlive the subordinate token
            // while its General WS remains authenticated. Reconfirm once through
            // the shared recovery barrier and retry this terminal transparently.
            if (!authRecoveryPromise) {
              authRecoveryPromise = vulcanClient.generalWS.ensureConnected({ reconfirm: true })
                .then(async () => {
                  if (cancelled || serverSwitchingRef.current) return;
                  reconnectAttempts = 0;
                  if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = null;
                  }
                  ws?.close();
                  await connect();
                })
                .catch((error: any) => {
                  xtermRef.current?.writeln(`\r\n[Terminal: ${String(error?.message || 'could not restore authentication')}]`);
                  onStatusChange?.('disconnected');
                })
                .finally(() => { authRecoveryPromise = null; });
            }
          } else if (msg.type === 'error') {
            xtermRef.current?.writeln(`\r\n[Terminal: ${String(msg.message || 'connection failed')}]`);
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        if (!cancelled) {
          if (!terminalClosed) {
            onStatusChange?.('disconnected');
            scheduleReconnect();
          }
        }
      };

      ws.onerror = () => {
        onStatusChange?.('disconnected');
      };

      // Both user and agent terminals accept direct user input. This lets the
      // user answer password, MFA, sudo, and other interactive prompts without
      // placing the input in chat history or tool arguments.
      if (xtermRef.current) {
        inputDisposable = xtermRef.current.onData((data) => {
          if (ws?.connected) {
            void ws.send({ type: 'input', text: data }).catch(() => {
              pendingInput += data;
            });
            return;
          }

          // Typing is an explicit wake signal. Buffer exactly what the user
          // typed, revive the stopped workspace, reconnect the same terminal
          // slot, then deliver the buffered input once the PTY reports ready.
          pendingInput += data;
          if (revivalPromise || cancelled || serverSwitchingRef.current) return;
          revivalPromise = (async () => {
            try {
              await vulcanClient.ensureContainer(chatId);
              if (cancelled || serverSwitchingRef.current) return;
              terminalClosed = false;
              reconnectAttempts = 0;
              if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
              }
              ws?.close();
              await connect();
            } catch (error: any) {
              xtermRef.current?.writeln(`\r\n[Terminal: ${String(error?.message || 'could not restart workspace')}]`);
              onStatusChange?.('disconnected');
            } finally {
              revivalPromise = null;
            }
          })();
        });
      }

      cleanupRef.current = () => {
        cancelled = true;
        wsRef.current = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        inputDisposable?.dispose();
        inputDisposable = null;
        // Viewer teardown only detaches. Explicit close belongs exclusively to
        // the user's close-terminal action and must never destroy a live PTY.
        ws?.close();
        onStatusChange?.('disconnected');
      };
    };

    connect();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [chatId, kind, slot]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'hidden',
        padding: '2px 4px',
        minHeight: 0,
        background: kind === 'agent' ? AGENT_THEME.background : VSCODE_THEME.background,
      }}
    />
  );
}
