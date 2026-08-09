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
import { SerializeAddon } from '@xterm/addon-serialize';
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
  onStatusChange?: (status: 'connected' | 'disconnected') => void;
}

export function TerminalSlotWidget({ chatId, kind, slot, onStatusChange }: TerminalSlotWidgetProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const xtermRef       = useRef<XTerm | null>(null);
  const fitAddonRef    = useRef<FitAddon | null>(null);
  const serializeRef   = useRef<SerializeAddon | null>(null);
  const fitTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef          = useRef<SecureWebSocket | null>(null);
  const cleanupRef     = useRef<(() => void) | null>(null);
  const chatIdRef      = useRef(chatId);
  const kindRef        = useRef(kind);
  const slotRef        = useRef(slot);

  // Keep refs in sync
  useEffect(() => { chatIdRef.current = chatId; }, [chatId]);
  useEffect(() => { kindRef.current   = kind;   }, [kind]);
  useEffect(() => { slotRef.current   = slot;   }, [slot]);

  const debouncedFit = useCallback(() => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
    fitTimerRef.current = setTimeout(() => {
      try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
    }, 100);
  }, []);

  // ── Scrollback save ────────────────────────────────────────────────────────
  const saveScrollback = useCallback(() => {
    const term = xtermRef.current;
    const ser  = serializeRef.current;
    if (!term || !ser) return;
    const serialized = ser.serialize();
    vulcanClient.saveSlotScrollback(
      chatIdRef.current, kindRef.current, slotRef.current, serialized
    ).catch(() => {});
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
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(serializeAddon);
    term.open(containerRef.current);
    setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);

    xtermRef.current    = term;
    fitAddonRef.current = fitAddon;
    serializeRef.current = serializeAddon;

    term.onResize(({ cols, rows }) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
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
      saveScrollback();
      term.dispose();
      xtermRef.current     = null;
      fitAddonRef.current  = null;
      serializeRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Connect to slot PTY via WebSocket ────────────────────────────────────────
  useEffect(() => {
    if (!chatId) return;

    cleanupRef.current?.();
    cleanupRef.current = null;
    xtermRef.current?.clear();

    let cancelled = false;
    let ws: SecureWebSocket | null = null;

    const connect = async () => {
      // Restore scrollback first
      try {
        const scrollback = await vulcanClient.getSlotScrollback(chatId, kind, slot);
        if (scrollback && xtermRef.current && !cancelled) {
          xtermRef.current.write(scrollback);
        }
      } catch { /* ignore */ }

      if (cancelled) return;

      // Open WebSocket to terminal slot
      const wsUrl = vulcanClient.slotStreamUrl(chatId, kind, slot);
      ws = new SecureWebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws?.close(); return; }
        void ws!.send({ type: 'open' }).then(async () => {
          const term = xtermRef.current;
          if (term) await ws!.send({ type: 'resize', cols: term.cols, rows: term.rows });
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
            onStatusChange?.(msg.connected ? 'connected' : 'disconnected');
          } else if (msg.type === 'closed') {
            onStatusChange?.('disconnected');
            ws?.close();
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        if (!cancelled) onStatusChange?.('disconnected');
      };

      ws.onerror = () => {
        onStatusChange?.('disconnected');
      };

      // Both user and agent terminals accept direct user input. This lets the
      // user answer password, MFA, sudo, and other interactive prompts without
      // placing the input in chat history or tool arguments.
      if (xtermRef.current) {
        xtermRef.current.onData((data) => {
          if (ws?.connected) void ws.send({ type: 'input', text: data });
        });
      }

      cleanupRef.current = () => {
        cancelled = true;
        wsRef.current = null;
        if (ws?.connected) void ws.send({ type: 'close' });
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
