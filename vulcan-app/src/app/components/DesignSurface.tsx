import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ExternalLink, MousePointer2, RotateCw, X } from 'lucide-react';
import * as vulcan from '../services/vulcan';
import type { DesignAttachment, MessageElementReference } from '../types/vulcan';

interface DesignSurfaceProps {
  design: DesignAttachment;
  chatId: string;
  onClose: () => void;
  onElement: (element: MessageElementReference) => void;
}

export interface DesignSurfaceHandle {
  isReady: () => boolean;
  getIdentity: () => { designId: string; targetUrl: string };
  invoke: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  captureScreenshot: () => Promise<unknown>;
}

type GuestMessageEvent = Event & { channel?: string; args?: unknown[] };
type GuestLoadFailureEvent = Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
type VulcanWebview = HTMLElement & {
  src?: string;
  reload?: () => void;
  send?: (channel: string, ...args: unknown[]) => void;
  getURL?: () => string;
  openDevTools?: () => void;
  getWebContentsId?: () => number;
  sendInputEvent?: (event: Record<string, unknown>) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function safeFragment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'design';
}

function electronKey(value: string): { keyCode: string; modifiers: string[] } {
  const pieces = String(value || '').split('+').map((part) => part.trim()).filter(Boolean);
  const rawKey = pieces.pop() || '';
  const aliases: Record<string, string> = { esc: 'Escape', return: 'Enter', space: 'Space', del: 'Delete' };
  const keyCode = aliases[rawKey.toLowerCase()] ?? (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);
  const modifiers = pieces.map((part) => {
    const lower = part.toLowerCase();
    if (lower === 'ctrl') return 'control';
    if (lower === 'cmd' || lower === 'command') return 'meta';
    if (lower === 'option') return 'alt';
    return lower;
  }).filter((value) => ['control', 'alt', 'shift', 'meta'].includes(value));
  return { keyCode, modifiers };
}


export const DesignSurface = forwardRef<DesignSurfaceHandle, DesignSurfaceProps>(function DesignSurface(
  { design, chatId, onClose, onElement },
  forwardedRef,
) {
  const webviewRef = useRef<VulcanWebview | null>(null);
  const readyRef = useRef(false);
  const selectingRef = useRef(false);
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>());
  const [selecting, setSelecting] = useState(false);
  const [draftUrl, setDraftUrl] = useState(design.url);
  const proxyUrl = useMemo(() => vulcan.designProxyUrl(chatId, design.id, design.url), [chatId, design.id, design.url]);
  const [loadedUrl, setLoadedUrl] = useState('about:blank');
  const [transportReady, setTransportReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const desktopDesignAvailable = typeof (window as any).electronAPI?.designTransport?.configure === 'function';
  const display = useMemo(() => displayUrl(design.url), [design.url]);

  const sendToGuest = useCallback((channel: string, ...args: unknown[]): boolean => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current || !webview.send || !webview.isConnected) return false;
    try {
      webview.send(channel, ...args);
      return true;
    } catch (error) {
      // Electron throws synchronously when a <webview> is detached or has not
      // reached dom-ready. Treat that as a local surface availability change,
      // never as a renderer-fatal exception.
      readyRef.current = false;
      console.warn('Design guest became unavailable before IPC send:', error);
      return false;
    }
  }, []);

  const sendGuestInput = useCallback((event: Record<string, unknown>): boolean => {
    const webview = webviewRef.current;
    if (!webview || !readyRef.current || !webview.sendInputEvent || !webview.isConnected) return false;
    try {
      webview.sendInputEvent(event);
      return true;
    } catch (error) {
      readyRef.current = false;
      console.warn('Design guest became unavailable before input event:', error);
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDraftUrl(design.url);
    setTransportReady(false);
    setLoadedUrl('about:blank');
    setLoadError(null);
    readyRef.current = false;
    void vulcan.configureDesignTransport(chatId, design.id, design.url).then(() => {
      if (cancelled) return;
      setLoadedUrl(proxyUrl);
      setTransportReady(true);
    }).catch((error) => {
      console.error('Failed to configure Design transport:', error);
    });
    return () => { cancelled = true; };
  }, [chatId, design.id, design.url, proxyUrl]);

  useEffect(() => {
    let first = true;
    return vulcan.generalWS.onSessionTokenChange(() => {
      // configureDesignTransport's initial effect already handles the first value.
      // Subsequent proof-of-life token rotations must update Electron's private
      // Design route or an otherwise healthy surface starts returning 401s.
      if (first) { first = false; return; }
      void vulcan.configureDesignTransport(chatId, design.id, design.url).catch((error) => {
        console.warn('Failed to refresh Design transport capability:', error);
      });
    });
  }, [chatId, design.id, design.url]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const onIpc = (raw: Event) => {
      const event = raw as GuestMessageEvent;
      if (event.channel === 'vulcan-design-element') {
        const detail = event.args?.[0] as Omit<MessageElementReference, 'id' | 'designId'> | undefined;
        if (!detail?.locator || !detail.hierarchyAddress || !detail.tagName) return;
        onElement({
          id: `element-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
          designId: design.id,
          ...detail,
        });
        setSelecting(false);
      } else if (event.channel === 'vulcan-design-select-cancelled') {
        setSelecting(false);
      } else if (event.channel === 'vulcan-design-tool-response') {
        const payload = event.args?.[0] as { requestId?: string; result?: unknown; error?: string } | undefined;
        if (!payload?.requestId) return;
        const pending = pendingRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingRequestsRef.current.delete(payload.requestId);
        if (payload.error) pending.reject(new Error(payload.error));
        else pending.resolve(payload.result);
      }
    };
    const onReady = () => {
      readyRef.current = true;
      setLoadError(null);
      sendToGuest('vulcan-design-context', {
        targetUrl: design.url,
        proxyPathPrefix: '/',
      });
      // Selection can be enabled before a navigation finishes. Apply the
      // current state only after this guest instance is actually ready.
      sendToGuest('vulcan-design-select-mode', selectingRef.current);
    };
    const onLoading = () => { readyRef.current = false; };
    const onFailed = (raw: Event) => {
      const event = raw as GuestLoadFailureEvent;
      if (event.isMainFrame === false || event.validatedURL === 'about:blank') return;
      readyRef.current = false;
      setSelecting(false);
      const description = event.errorDescription?.trim();
      setLoadError(description || 'The Design app could not be reached.');
    };
    webview.addEventListener('ipc-message', onIpc as EventListener);
    webview.addEventListener('dom-ready', onReady as EventListener);
    webview.addEventListener('did-start-loading', onLoading as EventListener);
    webview.addEventListener('did-fail-load', onFailed as EventListener);
    return () => {
      webview.removeEventListener('ipc-message', onIpc as EventListener);
      webview.removeEventListener('dom-ready', onReady as EventListener);
      webview.removeEventListener('did-start-loading', onLoading as EventListener);
      webview.removeEventListener('did-fail-load', onFailed as EventListener);
      readyRef.current = false;
    };
  }, [onElement, design.id, design.url, chatId, sendToGuest]);

  useEffect(() => () => {
    for (const pending of pendingRequestsRef.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('design_surface_unavailable'));
    }
    pendingRequestsRef.current.clear();
  }, []);

  useEffect(() => {
    selectingRef.current = selecting;
    // Selection state is independent of the guest lifecycle. Toggling Select
    // must not tear down the dom-ready listeners or clear readyRef. If the
    // guest is ready, apply immediately; otherwise onReady reads selectingRef.
    sendToGuest('vulcan-design-select-mode', selecting);
  }, [selecting, loadedUrl, sendToGuest]);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !selecting) return;
      event.preventDefault();
      setSelecting(false);
      sendToGuest('vulcan-design-select-mode', false);
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [selecting, sendToGuest]);

  const sendToolRequest = (toolName: string, args: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
    const webview = webviewRef.current;
    if (!desktopDesignAvailable || !webview || !readyRef.current || !webview.send) {
      reject(new Error('design_surface_unavailable'));
      return;
    }
    const requestId = `design-tool-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => {
      pendingRequestsRef.current.delete(requestId);
      reject(new Error('design_surface_timeout'));
    }, 8000);
    pendingRequestsRef.current.set(requestId, { resolve, reject, timer });
    if (!sendToGuest('vulcan-design-tool-request', { requestId, toolName, args })) {
      clearTimeout(timer);
      pendingRequestsRef.current.delete(requestId);
      reject(new Error('design_surface_unavailable'));
    }
  });

  useImperativeHandle(forwardedRef, () => ({
    isReady: () => Boolean(desktopDesignAvailable && webviewRef.current && readyRef.current),
    getIdentity: () => ({ designId: design.id, targetUrl: design.url }),
    invoke: async (toolName, args) => {
      const webview = webviewRef.current;
      if (!webview?.sendInputEvent || !readyRef.current) {
        if (toolName === 'design_click' || toolName === 'design_hover' || toolName === 'design_press') {
          return sendToolRequest(toolName, args);
        }
        return sendToolRequest(toolName, args);
      }
      if (toolName === 'design_hover' || toolName === 'design_click') {
        const point = await sendToolRequest('__design_target_point', { target: args.target });
        if (!sendGuestInput({ type: 'mouseMove', x: point.x, y: point.y })) throw new Error('design_surface_unavailable');
        if (toolName === 'design_click') {
          if (!sendGuestInput({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })) throw new Error('design_surface_unavailable');
          if (!sendGuestInput({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })) throw new Error('design_surface_unavailable');
        }
        return { ok: true, target: args.target, ...(point.route ? { route: point.route } : {}) };
      }
      if (toolName === 'design_press') {
        if (args.target) await sendToolRequest('__design_focus', { target: args.target });
        const key = electronKey(String(args.key ?? ''));
        if (!sendGuestInput({ type: 'keyDown', keyCode: key.keyCode, modifiers: key.modifiers })) throw new Error('design_surface_unavailable');
        if (!sendGuestInput({ type: 'keyUp', keyCode: key.keyCode, modifiers: key.modifiers })) throw new Error('design_surface_unavailable');
        return { ok: true, key: args.key, target: args.target ?? null };
      }
      return sendToolRequest(toolName, args);
    },
    captureScreenshot: async () => {
      const webview = webviewRef.current;
      const capture = (window as any).electronAPI?.designScreenshot?.capture;
      if (!desktopDesignAvailable || !webview || !readyRef.current || !webview.getWebContentsId || typeof capture !== 'function') {
        throw new Error('design_surface_unavailable');
      }
      const now = Date.now();
      const workspacePath = `screenshots/design-${safeFragment(design.name)}-${now}.png`;
      // Keep screenshot pixels entirely outside the host React renderer. Electron
      // main captures the guest and uploads raw PNG bytes directly to the Vulcan
      // server, which persists them in this chat's workspace. Only compact file
      // metadata crosses back through React / the Design tool result.
      const stored = await capture({
        webContentsId: webview.getWebContentsId(),
        chatId,
        designId: design.id,
        workspacePath,
      });
      return {
        ...stored,
        guidance: 'The screenshot is saved as a workspace PNG. Inspect it with view_file when visual context is needed.',
      };
    },
  }), [chatId, design.id, design.name, desktopDesignAvailable, sendGuestInput, sendToGuest]);

  const navigate = () => {
    // The registered URL is server-owned Design metadata. Navigation stays on
    // the stable Design proxy; changing the target belongs to design_update.
    setDraftUrl(design.url);
    setLoadedUrl(proxyUrl);
    setSelecting(false);
    setLoadError(null);
    readyRef.current = false;
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ash-950" data-vulcan-design={design.id}>
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-ash-800 bg-ash-900 px-2.5">
        <div className="min-w-0 shrink-0">
          <div className="max-w-[160px] truncate text-[11px] font-semibold text-ash-200">{design.name}</div>
        </div>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => { event.preventDefault(); navigate(); }}
        >
          <input
            value={draftUrl}
            readOnly
            onFocus={() => selecting && setSelecting(false)}
            className="h-7 w-full min-w-0 rounded-md border border-ash-700 bg-ash-950 px-2 text-[10px] text-ash-400 outline-none transition-colors focus:border-ash-500 focus:text-ash-200"
            aria-label="Design URL"
            title={loadedUrl}
          />
        </form>
        <button
          type="button"
          onClick={() => {
            setLoadError(null);
            setSelecting(false);
            readyRef.current = false;
            try { webviewRef.current?.reload?.(); } catch (error) {
              console.warn('Design reload requested before guest was ready:', error);
            }
          }}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ash-500 transition-colors hover:bg-ash-800 hover:text-ash-200"
          title="Reload Design"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setSelecting((current) => !current)}
          className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[10px] transition-colors ${selecting ? 'border-blue-500/70 bg-blue-500/15 text-blue-300' : 'border-ash-700 bg-ash-800 text-ash-300 hover:bg-ash-700'}`}
          title={selecting ? 'Selecting element — Esc to cancel' : 'Select an element from the live app'}
        >
          <MousePointer2 className="h-3.5 w-3.5" />
          {selecting ? 'Selecting…' : 'Select'}
        </button>
        <button
          type="button"
          onClick={() => window.open(design.url, '_blank', 'noopener,noreferrer')}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ash-500 transition-colors hover:bg-ash-800 hover:text-ash-200"
          title={`Open registered upstream ${display} externally`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { setSelecting(false); onClose(); }}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ash-500 transition-colors hover:bg-ash-800 hover:text-ash-200"
          title="Close Design"
          aria-label="Close Design"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-[#111]">
        {!desktopDesignAvailable ? (
          <div className="grid h-full place-items-center p-6 text-center text-xs text-ash-500">
            Design element selection requires the Electron desktop runtime.
          </div>
        ) : (
          <webview
            ref={(node: any) => { webviewRef.current = node; }}
            src={transportReady ? loadedUrl : 'about:blank'}
            partition={`persist:vulcan-design-${chatId}`}
            allowpopups="true"
            className="h-full w-full bg-white"
            style={{ display: 'flex' }}
          />
        )}
        {desktopDesignAvailable && loadError && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-[#111]/95 p-6 text-center">
            <div className="max-w-md rounded-lg border border-ash-800 bg-ash-900 p-4 shadow-xl">
              <div className="text-sm font-medium text-ash-200">Design unavailable</div>
              <div className="mt-1 text-xs leading-5 text-ash-500">{loadError}</div>
              <button
                type="button"
                onClick={() => navigate()}
                className="mt-3 rounded-md border border-ash-700 bg-ash-800 px-3 py-1.5 text-xs text-ash-200 transition-colors hover:bg-ash-700"
              >
                Retry
              </button>
            </div>
          </div>
        )}
        {selecting && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-blue-400/40 bg-[#15253a]/95 px-3 py-1.5 text-[10px] text-blue-200 shadow-lg backdrop-blur-sm">
            Select an element · <kbd className="rounded border border-blue-300/25 bg-blue-900/30 px-1 py-0.5 font-mono text-[9px]">Esc</kbd> to cancel
          </div>
        )}
      </div>
    </div>
  );
});
