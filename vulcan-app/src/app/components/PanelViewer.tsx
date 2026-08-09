import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, History, RotateCcw } from 'lucide-react';
import { FileTimeline } from './FileTimeline';
import type { TimelineEntry } from '../types/vulcan';
import { dashboardGet, dashboardUpdate, gitShow } from '../services/vulcan';
import { buildPanelDocument } from '../services/panelCache';
import { getVulcanBaseUrl } from '../services/vulcanEndpoint';

interface PanelViewerProps {
  chatId: string;
  name: string;
  onClose: () => void;
  onSendPrompt?: (text: string) => void;
}

type Mode = 'view' | 'history' | 'historical';

function injectContainerProxy(documentHtml: string, chatId: string): string {
  const vulcanBaseUrl = getVulcanBaseUrl().replace(/\/$/, '');
  const wsBaseUrl = vulcanBaseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const helper = `<script>(function(){
    const chatId = ${JSON.stringify(chatId)};
    const baseUrl = ${JSON.stringify(vulcanBaseUrl)};
    const wsBaseUrl = ${JSON.stringify(wsBaseUrl)};
    window.vulcan = Object.freeze({
      container: chatId,
      chatId,
      proxyUrl: (port, path = '') => baseUrl + '/proxy/' + chatId + '/' + port + '/' + String(path).replace(/^\\//, ''),
      proxyWsUrl: (port, path = '') => wsBaseUrl + '/proxy/ws/' + chatId + '/' + port + '/' + String(path).replace(/^\\//, '')
    });
  })();</script>`;
  if (/<body[^>]*>/i.test(documentHtml)) return documentHtml.replace(/(<body[^>]*>)/i, `$1\n${helper}`);
  return helper + documentHtml;
}

export function PanelViewer({ chatId, name, onClose }: PanelViewerProps) {
  const [mode, setMode] = useState<Mode>('view');
  const [html, setHtml] = useState<string>('');
  const [historicalHtml, setHistoricalHtml] = useState<string>('');
  const [selectedEntry, setSelectedEntry] = useState<TimelineEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const historicalIframeRef = useRef<HTMLIFrameElement>(null);

  // Panel files live at panels/<name>.json relative to the chat dir
  const gitPath = `panels/${name}.json`;

  const load = async () => {
    setLoading(true);
    try {
      const doc = await dashboardGet(chatId, name);
      setHtml(doc);
    } catch {
      setHtml('<body style="color:#e4e4e7;background:#18181b;padding:16px;font-family:sans-serif">Panel not found.</body>');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [chatId, name]);


  const handleSelectEntry = async (entry: TimelineEntry) => {
    setSelectedEntry(entry);
    if (entry.kind === 'commit') {
      try {
        // The JSON at this commit — parse and rebuild HTML client-side
        const raw = await gitShow(chatId, entry.commit.hash, gitPath);
        const data = JSON.parse(raw);
        setHistoricalHtml(buildPanelDocument({ html: data.html ?? '', css: data.css, js: data.js }));
      } catch {
        setHistoricalHtml('<body style="color:#e4e4e7;background:#18181b;padding:16px">Could not load this version.</body>');
      }
    }
    setMode('historical');
  };

  const handleBack = () => {
    if (mode === 'historical') {
      setMode('history');
      setSelectedEntry(null);
    } else {
      setMode('view');
    }
  };

  return (
    <div className="flex flex-col h-full bg-ash-950">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-ash-800 bg-ash-900 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {mode !== 'view' ? (
            <button
              onClick={handleBack}
              className="p-1 hover:bg-ash-800 rounded transition-colors text-ash-400 hover:text-ash-200"
              title="Back"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={onClose}
              className="p-1 hover:bg-ash-800 rounded transition-colors text-ash-400 hover:text-ash-200"
              title="Back to workspace"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-xs font-mono text-ash-200 truncate">⚡ {name}</span>
          {mode === 'historical' && selectedEntry?.kind === 'commit' && (
            <span className="text-xs text-ash-500 truncate">
              — {selectedEntry.commit.message}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {mode === 'view' && (
            <button
              onClick={() => setMode('history')}
              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-ash-800 hover:bg-ash-700 text-ash-400 hover:text-ash-200 rounded transition-colors"
            >
              <History className="w-3 h-3" />
              History
            </button>
          )}
          {mode === 'historical' && (
            <button
              onClick={async () => {
                if (!confirm('Restore this version? The panel will be updated immediately.')) return;
                if (selectedEntry?.kind === 'commit') {
                  try {
                    const raw = await gitShow(chatId, selectedEntry.commit.hash, gitPath);
                    const data = JSON.parse(raw);
                    await dashboardUpdate(chatId, name, 'html', data.html ?? '');
                    if (data.css !== undefined) await dashboardUpdate(chatId, name, 'css', data.css);
                    if (data.js !== undefined) await dashboardUpdate(chatId, name, 'js', data.js);
                    await load();
                    setMode('view');
                  } catch { /* ignore */ }
                }
              }}
              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-coral-500/20 text-coral-400 hover:bg-coral-500/30 rounded transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Restore
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full text-xs text-ash-500">
            Loading…
          </div>
        ) : mode === 'history' ? (
          <FileTimeline
            chatId={chatId}
            path={gitPath}
            onSelectEntry={handleSelectEntry}
          />
        ) : mode === 'historical' ? (
          <iframe
            ref={historicalIframeRef}
            srcDoc={historicalHtml}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            title={`${name} (historical)`}
          />
        ) : (
          <iframe
            ref={iframeRef}
            srcDoc={injectContainerProxy(html, chatId)}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            title={name}
          />
        )}
      </div>
    </div>
  );
}
