import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, Square } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { getVulcanBaseUrl, getVulcanWsBaseUrl } from '../services/vulcanEndpoint';

export interface TerminalState {
  lines: string[];
  running: boolean;
  pid: string | null;
  commandLabel: string | null;
}

interface TerminalWidgetProps {
  chatId: string | null;
  state: TerminalState;
  onUserInput: (text: string) => void;
  onStop: (reason: string) => void;
}

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

const HEADER_H     = 32;   // px — header height
const DEFAULT_H    = 220;  // px — default expanded height
const MIN_H        = 80;   // px — minimum drag height
const MAX_H_RATIO  = 0.75; // max fraction of parent height

export function TerminalWidget({ chatId, state, onUserInput, onStop }: TerminalWidgetProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const wrapperRef    = useRef<HTMLDivElement>(null);
  const xtermRef      = useRef<XTerm | null>(null);
  const fitAddonRef   = useRef<FitAddon | null>(null);
  const lastLineCount = useRef(0);
  const shellPidRef   = useRef<string | null>(null);
  const shellCleanup  = useRef<(() => void) | null>(null);
  const chatIdRef     = useRef<string | null>(chatId);
  const fitTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeInFlight = useRef(false);
  const pendingResize = useRef<{ cols: number; rows: number } | null>(null);

  const [collapsed, setCollapsed]   = useState(false);
  const [height, setHeight]         = useState(DEFAULT_H);   // remembered expanded height
  const [stopReason, setStopReason] = useState('');
  const [connected, setConnected]   = useState(false);

  // Keep ref in sync so callbacks closed over at mount always see the current chatId
  useEffect(() => { chatIdRef.current = chatId; }, [chatId]);

  // ── Drag-to-resize ────────────────────────────────────────────────────────
  const dragStart = useRef<{ y: number; h: number } | null>(null);

  const onDragMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStart.current = { y: e.clientY, h: height };

    const onMove = (ev: MouseEvent) => {
      if (!dragStart.current || !wrapperRef.current) return;
      const parent = wrapperRef.current.parentElement;
      const parentH = parent?.clientHeight ?? window.innerHeight;
      const delta = dragStart.current.y - ev.clientY; // dragging up = bigger
      const next  = Math.min(
        Math.max(dragStart.current.h + delta, MIN_H),
        parentH * MAX_H_RATIO,
      );
      setHeight(next);
      setCollapsed(false);
      // Don't fit on every frame — the ResizeObserver's debounced fit handles
      // intermediate sizes, and we do a final authoritative fit on mouseup.
    };

    const onUp = () => {
      dragStart.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Final fit once the drag settles — this is the size that sticks.
      requestAnimationFrame(() => { try { fitAddonRef.current?.fit(); } catch {} });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [height]);

  // ── Resize plumbing (VS Code style) ───────────────────────────────────────
  // Send the PTY resize only after the fit has settled, and serialize sends so
  // the PTY has time to apply each one before the next. If resizes pile up during
  // a drag, we coalesce to the latest and send it once the in-flight one returns.
  // This prevents a stale (smaller) size from landing last and desyncing the PTY.
  const sendResize = useCallback(async (cols: number, rows: number) => {
    const id = chatIdRef.current;
    if (!id) return;
    if (resizeInFlight.current) {
      pendingResize.current = { cols, rows };
      return;
    }
    resizeInFlight.current = true;
    try {
      await fetch(`${getVulcanBaseUrl()}/terminal/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, cols, rows }),
      });
    } catch { /* ignore */ }
    finally {
      resizeInFlight.current = false;
      // Flush the latest coalesced size, if one arrived while we were sending.
      const next = pendingResize.current;
      pendingResize.current = null;
      if (next && (next.cols !== cols || next.rows !== rows)) {
        sendResize(next.cols, next.rows);
      }
    }
  }, []);

  // Debounce fit() so rapid ResizeObserver / drag events settle before we resize
  // the terminal and, in turn, the PTY. 100ms matches VS Code's terminal debounce.
  const debouncedFit = useCallback(() => {
    if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
    fitTimerRef.current = setTimeout(() => {
      try { fitAddonRef.current?.fit(); } catch { /* ignore */ }
    }, 100);
  }, []);

  // ── Init xterm once ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || xtermRef.current) return;

    const term = new XTerm({
      theme:      VSCODE_THEME,
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize:   13,
      lineHeight: 1.2,
      cursorBlink:  true,
      cursorStyle:  'block',
      scrollback:   5000,
      convertEol:   true,
    });

    const fitAddon      = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);

    xtermRef.current    = term;
    fitAddonRef.current = fitAddon;

    // Notify Vulcan when terminal is resized so PTY window size stays in sync.
    // onResize only fires when cols/rows actually change; sendResize serializes
    // the network calls so the PTY never gets a stale size landing last.
    term.onResize(({ cols, rows }) => {
      sendResize(cols, rows);
    });

    // Ctrl+Shift+C — copy selection to clipboard (standard Linux terminal convention)
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
          return false; // prevent xterm from handling it
        }
      }
      return true;
    });

    term.onData(async (data) => {
      if (shellPidRef.current) {
        try {
          await fetch(`${getVulcanBaseUrl()}/terminal/input`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ pid: shellPidRef.current, text: data }),
          });
        } catch {}
      } else {
        onUserInput(data);
      }
    });

    if (state.lines.length > 0) {
      term.write(state.lines.join(''));
      lastLineCount.current = state.lines.length;
    }

    const ro = new ResizeObserver(() => debouncedFit());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
      shellCleanup.current?.();
      term.dispose();
      xtermRef.current    = null;
      fitAddonRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persistent shell ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!chatId) return;

    // Tear down any existing shell connection for the previous chat
    shellCleanup.current?.();
    shellCleanup.current = null;
    shellPidRef.current = null;
    setConnected(false);

    // Clear the terminal so the previous chat's output doesn't bleed in
    xtermRef.current?.clear();
    lastLineCount.current = 0;

    let cancelled = false;

    const startShell = async () => {
      try {
        // Start PTY shell
        const res = await fetch(`${getVulcanBaseUrl()}/terminal/shell`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ chat_id: chatId }),
        });
        if (!res.ok || cancelled) return;
        const { pid } = await res.json();
        if (cancelled) return;
        shellPidRef.current = pid;
        setConnected(true);

        // Sync PTY size to xterm's actual dimensions after shell starts
        setTimeout(() => {
          if (cancelled) return;
          try {
            fitAddonRef.current?.fit();
            const term = xtermRef.current;
            if (term) {
              fetch(`${getVulcanBaseUrl()}/terminal/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, cols: term.cols, rows: term.rows }),
              }).catch(() => {});
            }
          } catch {}
        }, 100);

        // Stream all shell output (PTY + agent command mirrors) to xterm
        const es = new EventSource(
          `${getVulcanBaseUrl()}/terminal/shell/stream?chat_id=${encodeURIComponent(chatId)}`
        );
        es.onmessage = (e) => {
          if (cancelled) { es.close(); return; }
          const data = JSON.parse(e.data);
          if (data.done) {
            setConnected(false);
            shellPidRef.current = null;
            es.close();
          } else if (data.chunk && xtermRef.current) {
            xtermRef.current.write(data.chunk);
          }
        };
        es.onerror = () => {
          setConnected(false);
          shellPidRef.current = null;
          es.close();
        };
        shellCleanup.current = () => {
          cancelled = true;
          es.close();
          setConnected(false);
          shellPidRef.current = null;
        };
      } catch {}
    };

    startShell();

    return () => {
      cancelled = true;
      shellCleanup.current?.();
      shellCleanup.current = null;
      shellPidRef.current = null;
    };
  }, [chatId]);

  // ── Write tool-output lines ───────────────────────────────────────────────
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const newLines = state.lines.slice(lastLineCount.current);
    if (newLines.length > 0) {
      term.write(newLines.join(''));
      lastLineCount.current = state.lines.length;
    }
  }, [state.lines]);

  // ── Auto-expand when agent attaches ──────────────────────────────────────
  useEffect(() => {
    if (state.running) setCollapsed(false);
  }, [state.running]);

  // ── Refit after expand ────────────────────────────────────────────────────
  useEffect(() => {
    if (!collapsed) {
      setTimeout(() => { try { fitAddonRef.current?.fit(); } catch {} }, 50);
    }
  }, [collapsed, height]);

  const handleStop = () => {
    onStop(stopReason);
    setStopReason('');
  };

  const currentH = collapsed ? HEADER_H : height;

  return (
    <div
      ref={wrapperRef}
      className="flex flex-col flex-shrink-0 w-full overflow-hidden"
      style={{ height: currentH, background: VSCODE_THEME.background }}
    >
      {/* Drag handle — sits above the header */}
      {!collapsed && (
        <div
          onMouseDown={onDragMouseDown}
          className="w-full flex-shrink-0 flex items-center justify-center group"
          style={{ height: 6, cursor: 'row-resize', background: '#252526' }}
          title="Drag to resize terminal"
        >
          <div
            className="rounded-full group-hover:bg-coral-400 transition-colors"
            style={{ width: 32, height: 2, background: '#444' }}
          />
        </div>
      )}

      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 border-b border-ash-800 cursor-pointer select-none flex-shrink-0"
        style={{ background: '#252526', height: HEADER_H }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <Terminal className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#cccccc' }} />
        <span className="text-xs flex-1 truncate" style={{ color: '#cccccc' }}>
          {state.running && state.commandLabel
            ? <>Running: <span className="font-mono" style={{ color: '#23d18b' }}>{state.commandLabel}</span></>
            : <span style={{ color: connected ? '#cccccc' : '#666666' }}>
                Terminal{connected ? '' : ' (disconnected)'}
              </span>
          }
        </span>
        {connected && !state.running && (
          <span className="flex items-center gap-1 text-xs flex-shrink-0" style={{ color: '#23d18b' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#23d18b' }} />
            Connected
          </span>
        )}
        {state.running && (
          <span className="flex items-center gap-1 text-xs flex-shrink-0" style={{ color: '#23d18b' }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: '#23d18b' }} />
            Assistant Attached
          </span>
        )}
        <span className="text-xs ml-1" style={{ color: '#555' }}>{collapsed ? '▲' : '▼'}</span>
      </div>

      {/* xterm — hidden via display:none when collapsed, never unmounted */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          padding: '2px 4px',
          display: collapsed ? 'none' : 'block',
          minHeight: 0,
        }}
      />

      {/* Detach row */}
      {!collapsed && state.running && (
        <div
          className="flex items-center gap-1 px-2 py-1.5 border-t border-ash-800/50 flex-shrink-0"
          style={{ background: '#252526' }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            value={stopReason}
            onChange={(e) => setStopReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleStop()}
            placeholder="Reason (optional)…"
            className="flex-1 bg-transparent text-xs focus:outline-none"
            style={{ color: '#cccccc' }}
          />
          <button
            onClick={handleStop}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors flex-shrink-0"
            style={{ background: 'rgba(205,49,49,0.2)', color: '#f14c4c' }}
          >
            <Square className="w-3 h-3" />
            Detach
          </button>
        </div>
      )}
    </div>
  );
}
