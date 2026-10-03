import { measureTerminal } from '../terminalDimensions';
/**
 * TerminalSlotWidget
 *
 * A single fully interactive terminal slot for either the agent or user.
 * Manages its own xterm instance and encrypted PTY WebSocket connection,
 * and scrollback serialization for app-restart persistence.
 */

import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
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
  active?: boolean;
}

export function TerminalSlotWidget({ chatId, kind, slot, onStatusChange, active = true }: TerminalSlotWidgetProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const xtermRef       = useRef<XTerm | null>(null);
  const fitTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeInFlight = useRef(false);
  const pendingResize  = useRef<{ cols: number; rows: number } | null>(null);
  const wsRef          = useRef<SecureWebSocket | null>(null);
  const cleanupRef     = useRef<(() => void) | null>(null);
  const serverSwitchingRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const replayingRef = useRef(false);
  const hostReportsRef = useRef(true);
  const streamRef = useRef({ generation: '', sequence: 0 });
  const resizeRequestRef = useRef<(cols: number, rows: number) => void>(() => {});
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!activeRef.current || replayingRef.current || !container || container.clientWidth < 2 || container.clientHeight < 2) return;
    try {
      const dims = xtermRef.current ? measureTerminal(xtermRef.current) : undefined;
      if (!dims || dims.cols < 2 || dims.rows < 1) return;
      if (wsRef.current?.connected) resizeRequestRef.current(dims.cols, dims.rows);
      else xtermRef.current?.resize(dims.cols, dims.rows);
    } catch { /* next layout will retry */ }
  }, []);

  const debouncedFit = useCallback(() => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
    fitTimerRef.current = setTimeout(() => {
      measure();
    }, 100);
  }, []);

  // Keep PTY geometry updates ordered and coalesced. ResizeObserver can emit a
  // burst while the panel/layout is settling; sending every intermediate size
  // independently lets a stale geometry race the final fit and desynchronize
  // xterm from the backing PTY. Preserve only the latest pending dimensions.
  const sendResize = useCallback(async (cols: number, rows: number) => {
    if (!activeRef.current || replayingRef.current || cols < 2 || rows < 1) return;
    if (resizeInFlight.current) {
      pendingResize.current = { cols, rows };
      return;
    }

    const socket = wsRef.current;
    if (!socket?.connected) return;

    resizeInFlight.current = true;
    try {
      await socket.send({ type: 'resize', cols, rows });
    } catch { /* reconnect/open will reassert authoritative geometry */ }
    finally {
      resizeInFlight.current = false;
      const next = pendingResize.current;
      pendingResize.current = null;
      if (next && (next.cols !== cols || next.rows !== rows)) {
        void sendResize(next.cols, next.rows);
      }
    }
  }, []);

  resizeRequestRef.current = (cols, rows) => { void sendResize(cols, rows); };

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
      convertEol:   false,
      allowProposedApi: true,
      // Both user and agent terminals accept direct user input.
      disableStdin: false,
    });

    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    // The authoritative headless emulator answers device queries once, even when
    // no viewer is attached. A viewer must never send a second answer to Bash.
    for (const final of ['c', 'n', 't']) {
      term.parser.registerCsiHandler({ final }, () => hostReportsRef.current || replayingRef.current);
      term.parser.registerCsiHandler({ prefix: '?', final }, () => hostReportsRef.current || replayingRef.current);
      term.parser.registerCsiHandler({ prefix: '>', final }, () => hostReportsRef.current || replayingRef.current);
    }
    for (const id of [4, 10, 11, 12]) term.parser.registerOscHandler(id, value => value.endsWith('?') && (hostReportsRef.current || replayingRef.current));
    const refreshFont = () => {
      // xterm's measured cells must be refreshed when a deferred font replaces
      // the fallback font; measuring against cached cells reproduces early wrap.
      (term as any)._core?._charSizeService?.measure();
      requestAnimationFrame(measure);
    };
    document.fonts.addEventListener('loadingdone', refreshFont);
    void document.fonts.ready.then(refreshFont);

    // Keep wheel input local to the terminal viewport. Without intercepting it
    // before xterm's PTY input path, wheel gestures can be translated into
    // cursor-key sequences by the terminal and cycle shell history instead of
    // scrolling scrollback.
    let wheelRemainder = 0;
    const terminalElement = containerRef.current;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const lineHeight = Math.max(1, term.options.fontSize * term.options.lineHeight);
      let deltaLines: number;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) deltaLines = event.deltaY;
      else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) deltaLines = event.deltaY * term.rows;
      else deltaLines = event.deltaY / lineHeight;

      wheelRemainder += deltaLines;
      const wholeLines = wheelRemainder < 0 ? Math.ceil(wheelRemainder) : Math.floor(wheelRemainder);
      if (wholeLines !== 0) {
        term.scrollLines(wholeLines);
        wheelRemainder -= wholeLines;
      }
    };
    terminalElement.addEventListener('wheel', handleWheel, { capture: true, passive: false });

    xtermRef.current    = term;

    // Geometry is applied only at its ordered stream barrier from the host.

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
      document.fonts.removeEventListener('loadingdone', refreshFont);
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
      cleanupRef.current?.();
      resizeInFlight.current = false;
      pendingResize.current = null;
      terminalElement.removeEventListener('wheel', handleWheel, { capture: true });
      term.dispose();
      xtermRef.current    = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching terminal tabs must not destroy/replay the xterm instance. All open
  // slots stay mounted; activation only makes this viewer visible and refreshes
  // its fit/focus against the shared viewport.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      measure();
      try { xtermRef.current?.focus(); } catch { /* no-op */ }
    }, 0);
    return () => clearTimeout(timer);
  }, [active]);

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
    let renderQueue = Promise.resolve();
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
      await document.fonts.ready;
      measure();
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
            const terminal = xtermRef.current;
            streamRef.current = { generation: msg.generation || '', sequence: msg.sequence || 0 };
            renderQueue = renderQueue.then(async () => {
              if (cancelled) return;
              replayingRef.current = true;
              hostReportsRef.current = !msg.legacy;
              await new Promise<void>(resolve => terminal.write('', resolve));
              terminal.reset();
              if (msg.cols >= 2 && msg.rows >= 1) terminal.resize(msg.cols, msg.rows);
              await new Promise<void>(resolve => terminal.write(msg.data || '', resolve));
              replayingRef.current = false;
              requestAnimationFrame(measure);
            });
          } else if (msg.type === 'chunk' && xtermRef.current) {
            if (msg.generation && (msg.generation !== streamRef.current.generation || msg.sequence <= streamRef.current.sequence)) return;
            if (msg.generation) streamRef.current.sequence = msg.sequence;
            const terminal = xtermRef.current;
            renderQueue = renderQueue.then(async () => {
              if (cancelled) return;
              if (msg.cols >= 2 && msg.rows >= 1) terminal.resize(msg.cols, msg.rows);
              else await new Promise<void>(resolve => terminal.write(msg.data || '', resolve));
            });
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
          if (replayingRef.current) return;
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
      aria-hidden={!active}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        padding: '2px 4px',
        minHeight: 0,
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
        background: kind === 'agent' ? AGENT_THEME.background : VSCODE_THEME.background,
      }}
    />
  );
}
