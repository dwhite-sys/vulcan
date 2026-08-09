import { useRef, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

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
function SandboxedFrame({ srcdoc }: { srcdoc: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    const onLoad = () => {
      try {
        const h = iframe.contentDocument?.documentElement?.scrollHeight;
        if (h && h > 0) setHeight(Math.min(h + 4, 800)); // cap at 800px
      } catch {
        // cross-origin sandbox blocks access — leave default height
      }
    };

    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [srcdoc]);

  return (
    <iframe
      ref={ref}
      srcdoc={srcdoc}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      style={{ width: '100%', height, border: 'none', display: 'block' }}
      title="Rendered output"
    />
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
    window.addEventListener('load', () => {
      setTimeout(() => {
        const h = document.documentElement.scrollHeight;
        window.parent.postMessage({ type: 'resize', height: h }, '*');
      }, 500);
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
  const [collapsed, setCollapsed] = useState(false);
  const mermaidRef = useRef<HTMLIFrameElement>(null);
  const [mermaidHeight, setMermaidHeight] = useState(200);

  // Listen for postMessage height updates from Mermaid iframe
  useEffect(() => {
    if (type !== 'mermaid') return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'resize' && typeof e.data.height === 'number') {
        setMermaidHeight(Math.min(e.data.height + 4, 800));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [type]);

  const label =
    type === 'svg' ? 'SVG' :
    type === 'mermaid' ? 'Diagram' :
    'HTML';

  return (
    <div className="my-2 rounded-lg overflow-hidden border border-ash-700/50">
      {/* Collapse toggle header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-1.5 bg-ash-800/60 hover:bg-ash-800 transition-colors text-left"
      >
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-ash-500 flex-shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-ash-500 flex-shrink-0" />
        }
        <span className="text-xs text-ash-400 font-medium">{label}</span>
      </button>

      {/* Rendered content */}
      {!collapsed && (
        <div className="bg-ash-900/40">
          {type === 'svg' ? (
            <div
              className="p-3 flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
              dangerouslySetInnerHTML={{ __html: sanitizeSVG(content) }}
            />
          ) : type === 'mermaid' ? (
            <iframe
              ref={mermaidRef}
              srcdoc={buildMermaidSrcdoc(content)}
              sandbox="allow-scripts allow-same-origin"
              style={{ width: '100%', height: mermaidHeight, border: 'none', display: 'block' }}
              title="Mermaid diagram"
            />
          ) : (
            <SandboxedFrame srcdoc={buildHtmlSrcdoc(content)} />
          )}
        </div>
      )}
    </div>
  );
}
