import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Copy, Download, Maximize2, Minimize2, MoreHorizontal, X } from 'lucide-react';

const MAX_VISUALIZATION_HEIGHT = 720;
const VISUALIZATION_VIEWPORT_LIMIT = 'min(720px, 68vh)';
const FRAME_HEIGHT_SETTLE_MS = 180;
const FRAME_WIDTH_BUCKET = 32;
const FRAME_CACHE_LIMIT = 256;

// Transcript rows are virtualized, so an iframe can be destroyed and recreated many
// times while scrolling. Keep the geometry learned by an earlier mount outside the
// component instance so a remount can reserve the settled height immediately.
const frameHeightCache = new Map<string, number>();
const mermaidSnapshotCache = new Map<string, string>();

function stableContentKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function rememberBounded<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > FRAME_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function useDismissableMenu(open: boolean, onClose: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return rootRef;
}

function clampFrameHeight(height: number, minimum = 100): number {
  return Math.min(Math.max(Math.ceil(height) + 4, minimum), MAX_VISUALIZATION_HEIGHT);
}

function useCachedFrameHeight(namespace: string, contentKey: string, defaultHeight: number) {
  const hostRef = useRef<HTMLDivElement>(null);
  const activeCacheKey = useRef(`${namespace}:${contentKey}:0`);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [height, setHeight] = useState(defaultHeight);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const applyWidth = () => {
      const width = Math.max(host.clientWidth, 1);
      const bucket = Math.max(FRAME_WIDTH_BUCKET, Math.round(width / FRAME_WIDTH_BUCKET) * FRAME_WIDTH_BUCKET);
      const key = `${namespace}:${contentKey}:${bucket}`;
      activeCacheKey.current = key;
      const cached = frameHeightCache.get(key);
      setHeight(cached ?? defaultHeight);
    };

    applyWidth();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(applyWidth);
    observer.observe(host);
    return () => observer.disconnect();
  }, [namespace, contentKey, defaultHeight]);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const settleHeight = useCallback((rawHeight: number, minimum = 100) => {
    if (!Number.isFinite(rawHeight) || rawHeight <= 0) return;
    const next = clampFrameHeight(rawHeight, minimum);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      setHeight(next);
      rememberBounded(frameHeightCache, activeCacheKey.current, next);
    }, FRAME_HEIGHT_SETTLE_MS);
  }, []);

  return { hostRef, height, settleHeight };
}

// ── SVG sanitizer ─────────────────────────────────────────────────────────────
function sanitizeSVG(svg: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svg, 'image/svg+xml');

  // Remove script tags
  doc.querySelectorAll('script').forEach((el) => el.remove());

  // Remove on* event attributes from all elements
  doc.querySelectorAll('*').forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    });
    // Remove xlink:href and href pointing to javascript:
    ['href', 'xlink:href'].forEach((a) => {
      const val = el.getAttribute(a) ?? '';
      if (val.trim().toLowerCase().startsWith('javascript:')) el.removeAttribute(a);
    });
  });

  return new XMLSerializer().serializeToString(doc.documentElement);
}

// ── Auto-sizing iframe ────────────────────────────────────────────────────────
function SandboxedFrame({ srcdoc, onInteract }: { srcdoc: string; onInteract?: () => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const contentKey = stableContentKey(srcdoc);
  const { hostRef, height, settleHeight } = useCachedFrameHeight('html', contentKey, 200);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    const onLoad = () => {
      try {
        const root = iframe.contentDocument?.documentElement;
        const body = iframe.contentDocument?.body;
        const h = Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0);
        settleHeight(h);
      } catch {
        // cross-origin sandbox blocks access — keep the cached/default height
      }
    };

    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [srcdoc, settleHeight]);

  return (
    <div ref={hostRef}>
      <iframe
        ref={ref}
        srcdoc={srcdoc}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onFocus={onInteract}
        style={{ width: '100%', height, maxHeight: VISUALIZATION_VIEWPORT_LIMIT, border: 'none', display: 'block' }}
        title="Rendered output"
      />
    </div>
  );
}

// ── Mermaid wrapper ───────────────────────────────────────────────────────────
function buildMermaidSrcdoc(diagram: string): string {
  // Escape HTML entities to safely embed diagram in a div
  const escaped = diagram
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body {
      margin: 0;
      padding: 8px;
      background: transparent;
      font-family: sans-serif;
    }
    .mermaid { display: flex; justify-content: center; }
    svg { max-width: 100%; height: auto; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
</head>
<body>
  <pre class="mermaid">${escaped}</pre>
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'dark' });
    const report = () => {
      const h = document.documentElement.scrollHeight;
      const svg = document.querySelector('.mermaid svg')?.outerHTML || '';
      window.parent.postMessage({ type: 'vulcan-mermaid-ready', height: h, svg }, '*');
    };
    window.addEventListener('load', () => {
      setTimeout(report, 120);
      setTimeout(report, 500);
    });
  <\/script>
</body>
</html>`;
}

// ── HTML wrapper ──────────────────────────────────────────────────────────────
function buildHtmlSrcdoc(html: string): string {
  // Inject a dark background and reset styles so it fits the chat theme
  const hasHtmlTag = /<html/i.test(html);
  if (hasHtmlTag) return html; // use as-is if it's a full document

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body {
      margin: 0;
      padding: 8px;
      background: #18181b;
      color: #e4e4e7;
      font-family: sans-serif;
      font-size: 14px;
    }
    * { box-sizing: border-box; }
  </style>
</head>
<body>${html}</body>
</html>`;
}

// ── Main component ────────────────────────────────────────────────────────────
export type RenderType = 'svg' | 'html' | 'mermaid';

interface RenderToUserProps {
  content: string;
  type: RenderType;
}

export function RenderToUser({ content, type }: RenderToUserProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRootRef = useDismissableMenu(menuOpen, () => setMenuOpen(false));
  const mermaidRef = useRef<HTMLIFrameElement>(null);
  const mermaidKey = stableContentKey(content);
  const [mermaidSnapshot, setMermaidSnapshot] = useState(() => mermaidSnapshotCache.get(mermaidKey) ?? '');
  const { hostRef: mermaidHostRef, height: mermaidHeight, settleHeight: settleMermaidHeight } = useCachedFrameHeight('mermaid', mermaidKey, 180);

  useEffect(() => {
    setMermaidSnapshot(mermaidSnapshotCache.get(mermaidKey) ?? '');
  }, [mermaidKey]);

  // The first mount runs Mermaid in its sandbox. Once rendered, cache the SVG itself.
  // Virtualized remounts can then use a static SVG instead of recreating an iframe,
  // reloading Mermaid, and rediscovering the same geometry on every scroll pass.
  useEffect(() => {
    if (type !== 'mermaid' || mermaidSnapshot) return;
    const handler = (e: MessageEvent) => {
      if (e.source !== mermaidRef.current?.contentWindow) return;
      if (e.data?.type !== 'vulcan-mermaid-ready') return;
      if (typeof e.data.height === 'number') settleMermaidHeight(e.data.height);
      if (typeof e.data.svg === 'string' && e.data.svg.trim()) {
        const sanitized = sanitizeSVG(e.data.svg);
        rememberBounded(mermaidSnapshotCache, mermaidKey, sanitized);
        setMermaidSnapshot(sanitized);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [type, mermaidKey, mermaidSnapshot, settleMermaidHeight]);

  const renderedSvg = type === 'svg' ? sanitizeSVG(content) : (type === 'mermaid' ? mermaidSnapshot : '');
  const exportText = renderedSvg || content;
  const exportExt = renderedSvg ? 'svg' : (type === 'html' ? 'html' : 'mmd');
  const baseName = `vulcan-visualization-${stableContentKey(content)}`;

  const downloadBlob = (filename: string, blob: Blob) => {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 500);
  };

  const copyVisualization = async () => {
    await navigator.clipboard.writeText(exportText);
    setMenuOpen(false);
  };

  const downloadVisualization = () => {
    const mime = exportExt === 'svg' ? 'image/svg+xml' : exportExt === 'html' ? 'text/html' : 'text/plain';
    downloadBlob(`${baseName}.${exportExt}`, new Blob([exportText], { type: `${mime};charset=utf-8` }));
    setMenuOpen(false);
  };

  const downloadPng = async () => {
    if (!renderedSvg) return;
    const source = new Blob([renderedSvg], { type: 'image/svg+xml;charset=utf-8' });
    const href = URL.createObjectURL(source);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Could not rasterize visualization'));
        image.src = href;
      });
      const width = Math.max(1, image.naturalWidth || 1200);
      const height = Math.max(1, image.naturalHeight || 720);
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is unavailable');
      ctx.scale(scale, scale);
      ctx.drawImage(image, 0, 0, width, height);
      const png = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed')), 'image/png');
      });
      downloadBlob(`${baseName}.png`, png);
    } finally {
      URL.revokeObjectURL(href);
      setMenuOpen(false);
    }
  };

  return (
    <div className="group/viz relative my-3 w-full">
      <div className="relative rounded-xl border border-transparent bg-transparent p-2 transition-colors group-hover/viz:border-ash-700/60 group-hover/viz:bg-ash-900/15">
        <div ref={menuRootRef} data-menu-dismiss="outside-and-escape" className={`absolute right-2 top-2 z-20 transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover/viz:opacity-100'}`}>
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-label="Visualization actions"
            aria-expanded={menuOpen}
            className="grid h-7 w-8 place-items-center rounded-md border border-ash-700 bg-ash-800/95 text-ash-400 shadow-lg hover:bg-ash-700 hover:text-ash-200"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-9 w-44 rounded-lg border border-ash-700 bg-ash-800 p-1 shadow-2xl">
              <button type="button" onClick={() => { void copyVisualization(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ash-300 hover:bg-ash-700">
                <Copy className="h-3.5 w-3.5 text-ash-500" /> Copy to clipboard
              </button>
              <button type="button" onClick={downloadVisualization} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ash-300 hover:bg-ash-700">
                <Download className="h-3.5 w-3.5 text-ash-500" /> Download {exportExt.toUpperCase()}
              </button>
              {renderedSvg && (
                <button type="button" onClick={() => { void downloadPng(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ash-300 hover:bg-ash-700">
                  <Download className="h-3.5 w-3.5 text-ash-500" /> Download PNG
                </button>
              )}
            </div>
          )}
        </div>

        {type === 'svg' ? (
          <div
            className="flex justify-center overflow-auto p-1 [&_svg]:block [&_svg]:max-w-full [&_svg]:h-auto"
            style={{ maxHeight: VISUALIZATION_VIEWPORT_LIMIT }}
            dangerouslySetInnerHTML={{ __html: renderedSvg }}
          />
        ) : type === 'mermaid' ? (
          mermaidSnapshot ? (
            <div
              className="flex justify-center overflow-auto p-1 [&_svg]:block [&_svg]:max-w-full [&_svg]:h-auto"
              style={{ maxHeight: VISUALIZATION_VIEWPORT_LIMIT }}
              dangerouslySetInnerHTML={{ __html: mermaidSnapshot }}
            />
          ) : (
            <div ref={mermaidHostRef}>
              <iframe
                ref={mermaidRef}
                srcdoc={buildMermaidSrcdoc(content)}
                sandbox="allow-scripts allow-same-origin"
                onFocus={() => setMenuOpen(false)}
                style={{ width: '100%', height: mermaidHeight, maxHeight: VISUALIZATION_VIEWPORT_LIMIT, border: 'none', display: 'block' }}
                title="Mermaid diagram"
              />
            </div>
          )
        ) : (
          <SandboxedFrame srcdoc={buildHtmlSrcdoc(content)} onInteract={() => setMenuOpen(false)} />
        )}
      </div>
    </div>
  );
}


// ── Preview bundle download ───────────────────────────────────────────────────
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value & 0xffff, true);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function dosTimestamp(date = new Date()): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function buildStoredZip(entries: Array<{ name: string; text: string }>): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  const stamp = dosTimestamp();

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const checksum = crc32(data);
    const localHeader = concatBytes([
      u32(0x04034b50), // local file header signature
      u16(20),         // version needed
      u16(0x0800),     // UTF-8 filenames
      u16(0),          // stored (no compression)
      u16(stamp.time),
      u16(stamp.day),
      u32(checksum),
      u32(data.byteLength),
      u32(data.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
    ]);
    localParts.push(localHeader, data);

    const centralHeader = concatBytes([
      u32(0x02014b50), // central directory signature
      u16(20),         // version made by
      u16(20),         // version needed
      u16(0x0800),
      u16(0),
      u16(stamp.time),
      u16(stamp.day),
      u32(checksum),
      u32(data.byteLength),
      u32(data.byteLength),
      u16(name.byteLength),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(localOffset),
      name,
    ]);
    centralParts.push(centralHeader);
    localOffset += localHeader.byteLength + data.byteLength;
  }

  const central = concatBytes(centralParts);
  const local = concatBytes(localParts);
  const end = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.byteLength),
    u32(local.byteLength),
    u16(0),
  ]);
  return new Blob([local, central, end], { type: 'application/zip' });
}

function buildDownloadablePreviewHtml(html: string, hasCss: boolean, hasJs: boolean): string {
  const stylesheet = hasCss ? '<link rel="stylesheet" href="./styles.css">' : '';
  const script = hasJs ? '<script src="./script.js"></script>' : '';
  if (/<html[\s>]/i.test(html)) {
    let document = html;
    if (stylesheet) document = injectPreviewPart(document, 'head', stylesheet);
    if (script) document = injectPreviewPart(document, 'body', script);
    return document;
  }
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8" />${stylesheet}</head><body>${html}${script}</body></html>`;
}

// ── Preview bundle ────────────────────────────────────────────────────────────
function injectPreviewPart(document: string, tag: 'head' | 'body', injection: string): string {
  const close = new RegExp(`</${tag}\\s*>`, 'i');
  if (close.test(document)) return document.replace(close, `${injection}</${tag}>`);
  return document + injection;
}

function injectPreviewFoundation(document: string, injection: string): string {
  const openHead = /<head\b[^>]*>/i;
  if (openHead.test(document)) return document.replace(openHead, (match) => `${match}${injection}`);
  const openHtml = /<html\b[^>]*>/i;
  if (openHtml.test(document)) return document.replace(openHtml, (match) => `${match}<head>${injection}</head>`);
  return injection + document;
}

const PREVIEW_FOUNDATION_STYLE = `<style data-vulcan-preview-foundation>
  html, body {
    margin: 0;
    width: 100%;
    background: #18181b;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
</style>`;

const PREVIEW_SIZE_BRIDGE = `<script data-vulcan-preview-size-bridge>
(() => {
  const report = () => {
    const body = document.body;
    if (!body) return;
    const bodyRect = body.getBoundingClientRect();
    let bottom = Math.max(0, bodyRect.height);
    for (const child of body.children) {
      const rect = child.getBoundingClientRect();
      bottom = Math.max(bottom, rect.bottom - bodyRect.top);
    }
    parent.postMessage({ type: 'vulcan-preview-content-size', height: Math.ceil(bottom) }, '*');
  };
  const schedule = () => requestAnimationFrame(report);
  addEventListener('load', schedule);
  new ResizeObserver(schedule).observe(document.documentElement);
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  schedule();
})();
<\/script>`;

function buildPreviewSrcdoc(html: string, css = '', js = ''): string {
  const style = css ? `<style data-vulcan-preview-css>${css}</style>` : '';
  const script = js ? `<script data-vulcan-preview-js>${js}<\/script>` : '';
  if (/<html[\s>]/i.test(html)) {
    let document = injectPreviewFoundation(html, PREVIEW_FOUNDATION_STYLE);
    if (style) document = injectPreviewPart(document, 'head', style);
    if (script) document = injectPreviewPart(document, 'body', script);
    return injectPreviewPart(document, 'body', PREVIEW_SIZE_BRIDGE);
  }
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
${PREVIEW_FOUNDATION_STYLE}${style}
</head><body>${html}${script}${PREVIEW_SIZE_BRIDGE}</body></html>`;
}

function PreviewFrame({ srcdoc, fullscreen, onInteract }: { srcdoc: string; fullscreen: boolean; onInteract?: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  useEffect(() => {
    setContentHeight(null);
  }, [srcdoc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type !== 'vulcan-preview-content-size') return;
      const height = Number(event.data.height);
      if (!Number.isFinite(height) || height <= 0) return;
      setContentHeight(Math.ceil(height));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (fullscreen) {
    return (
      <div
        className="relative overflow-hidden rounded-lg bg-[#18181b]"
        style={{ width: 'min(100vw, 177.7778vh)', maxWidth: '100vw', maxHeight: '100vh', aspectRatio: '16 / 9' }}
        data-preview-aspect="16:9"
      >
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-forms allow-popups"
          onFocus={onInteract}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: '#18181b' }}
          title="Preview"
        />
      </div>
    );
  }

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg bg-[#18181b]"
      style={{ width: '100%', aspectRatio: '16 / 9', ...(contentHeight ? { maxHeight: `${contentHeight}px` } : {}) }}
      data-preview-aspect="16:9"
      data-preview-content-height={contentHeight ?? undefined}
    >
      <div className="absolute left-0 top-0 w-full" style={{ aspectRatio: '16 / 9' }}>
        <iframe
          ref={iframeRef}
          srcDoc={srcdoc}
          sandbox="allow-scripts allow-forms allow-popups"
          onFocus={onInteract}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: '#18181b' }}
          title="Preview"
        />
      </div>
    </div>
  );
}

export function RenderPreview({ html, css = '', js = '' }: { html: string; css?: string; js?: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const artifactRef = useRef<HTMLDivElement>(null);
  const menuRootRef = useDismissableMenu(menuOpen, () => setMenuOpen(false));
  const srcdoc = buildPreviewSrcdoc(html, css, js);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === artifactRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    const artifact = artifactRef.current;
    if (!artifact) return;
    if (document.fullscreenElement === artifact) await document.exitFullscreen();
    else await artifact.requestFullscreen();
    setMenuOpen(false);
  };


  const downloadPreviewZip = () => {
    const entries: Array<{ name: string; text: string }> = [
      { name: 'index.html', text: buildDownloadablePreviewHtml(html, Boolean(css), Boolean(js)) },
    ];
    if (css) entries.push({ name: 'styles.css', text: css });
    if (js) entries.push({ name: 'script.js', text: js });
    const blob = buildStoredZip(entries);
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `vulcan-preview-${stableContentKey(`${html}\u0000${css}\u0000${js}`)}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 500);
    setMenuOpen(false);
  };

  if (collapsed) {
    return (
      <div className="my-2 rounded-lg border border-ash-700/50 bg-ash-800/40">
        <button type="button" onClick={() => setCollapsed(false)} aria-expanded="false" className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-ash-800">
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-ash-500" />
          <span className="text-xs font-medium text-ash-400">Preview</span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={artifactRef}
      className={fullscreen
        ? 'group/preview relative flex h-screen w-screen items-center justify-center bg-ash-950 p-4'
        : 'group/preview relative my-3 w-full'}
      data-preview-surface="artifact"
    >
      <div className={fullscreen
        ? 'relative flex h-full w-full items-center justify-center'
        : 'relative rounded-xl border border-transparent bg-ash-900/15 p-2 transition-colors group-hover/preview:border-ash-700/60 group-hover/preview:bg-ash-900/20'}
      >
        <div ref={menuRootRef} data-menu-dismiss="outside-and-escape" className={`absolute right-2 top-2 z-20 transition-opacity ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover/preview:opacity-100'}`}>
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            aria-label="Preview actions"
            aria-expanded={menuOpen}
            className="grid h-7 w-8 place-items-center rounded-md border border-ash-700 bg-ash-800/95 text-ash-400 shadow-lg hover:bg-ash-700 hover:text-ash-200"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-9 w-44 rounded-lg border border-ash-700 bg-ash-800 p-1 shadow-2xl">
              <button type="button" onClick={() => { void toggleFullscreen(); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ash-300 hover:bg-ash-700">
                {fullscreen ? <Minimize2 className="h-3.5 w-3.5 text-ash-500" /> : <Maximize2 className="h-3.5 w-3.5 text-ash-500" />}
                {fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              </button>
              <button type="button" onClick={downloadPreviewZip} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ash-300 hover:bg-ash-700">
                <Download className="h-3.5 w-3.5 text-ash-500" /> Download ZIP
              </button>
              {!fullscreen && (
                <button type="button" onClick={() => { setCollapsed(true); setMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ash-300 hover:bg-ash-700">
                  <ChevronDown className="h-3.5 w-3.5 text-ash-500" /> Collapse preview
                </button>
              )}
            </div>
          )}
        </div>

        <PreviewFrame srcdoc={srcdoc} fullscreen={fullscreen} onInteract={() => setMenuOpen(false)} />
      </div>
    </div>
  );
}
