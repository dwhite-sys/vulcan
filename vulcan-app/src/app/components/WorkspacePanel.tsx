import { useState, useEffect, useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { FileText, FileCode, Image, File, Search, X, Download, LayoutDashboard } from 'lucide-react';
import { FileEditor } from './FileEditor';
import { FileBrowser } from './FileBrowser';
import { PanelViewer } from './PanelViewer';
import { TerminalSlotWidget } from './TerminalSlotWidget';
import { TerminalBar } from './TerminalBar';
import { readFileBase64 } from '../services/vulcan';
import * as vulcanClient from '../services/vulcan';
import type { PresentedFile, MessageAttachment, Panel as PanelMeta, TerminalSlotMeta, SlotKind } from '../types/vulcan';

// ── File icon helper ──────────────────────────────────────────────────────────
function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'txt'].includes(ext)) return <FileText className="w-3.5 h-3.5 text-ash-400 flex-shrink-0" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <Image className="w-3.5 h-3.5 text-coral-400 flex-shrink-0" />;
  if (['py', 'ts', 'tsx', 'js', 'jsx', 'json', 'yml', 'yaml', 'sh', 'rs', 'go'].includes(ext))
    return <FileCode className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />;
  return <File className="w-3.5 h-3.5 text-ash-500 flex-shrink-0" />;
}

function isEditable(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return !['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'tar', 'gz'].includes(ext);
}

async function downloadWorkspaceFile(chatId: string, path: string, name: string) {
  try {
    const { base64, mimeType } = await readFileBase64(chatId, path);
    const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  } catch { /* ignore */ }
}

function downloadAttachment(attachment: MessageAttachment) {
  if (!attachment.dataUrl) return;
  const a = document.createElement('a');
  a.href = attachment.dataUrl;
  a.download = attachment.name;
  a.click();
}

// ── Content tab ───────────────────────────────────────────────────────────────
interface ContentTabProps {
  chatId: string | null;
  presentedFiles: PresentedFile[];
  panels: PanelMeta[];
  attachments: MessageAttachment[];
  onOpenFile: (path: string, name: string) => void;
  onOpenPanel: (panel: PanelMeta) => void;
}

function ContentTab({ chatId, presentedFiles, panels, attachments, onOpenFile, onOpenPanel }: ContentTabProps) {
  const [artifactSearch, setArtifactSearch] = useState('');

  const filteredArtifacts = artifactSearch.trim()
    ? presentedFiles.filter((f) => f.name.toLowerCase().includes(artifactSearch.toLowerCase()))
    : presentedFiles;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Artifacts */}
      <div className="px-3 pt-3 pb-1 flex-shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-ash-400 uppercase tracking-wide">
            Artifacts
            {presentedFiles.length > 0 && <span className="ml-1 text-ash-600">({presentedFiles.length})</span>}
          </span>
        </div>
        {presentedFiles.length > 3 && (
          <div className="relative mb-2">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ash-600" />
            <input
              type="text"
              value={artifactSearch}
              onChange={(e) => setArtifactSearch(e.target.value)}
              placeholder="Search artifacts…"
              className="w-full bg-ash-800 text-xs text-ash-300 placeholder-zinc-600 rounded px-6 py-1 focus:outline-none focus:ring-1 focus:ring-coral-500/50"
            />
            {artifactSearch && (
              <button onClick={() => setArtifactSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ash-600 hover:text-ash-400">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>
      {filteredArtifacts.length === 0 ? (
        <div className="px-3 py-2 text-xs text-ash-600">{artifactSearch ? 'No matches' : 'Nothing presented yet'}</div>
      ) : (
        <div className="px-2 pb-2">
          {filteredArtifacts.map((file, idx) => (
            <div key={idx} className="group flex items-center w-full hover:bg-ash-800/60 transition-colors rounded">
              <button
                onClick={() => isEditable(file.name) ? onOpenFile(file.path, file.name) : undefined}
                className="flex items-center gap-1.5 flex-1 text-left py-1 min-w-0 pl-1"
              >
                {fileIcon(file.name)}
                <span className="text-xs font-mono text-ash-300 truncate">{file.name}</span>
              </button>
              {chatId && (
                <button
                  onClick={(e) => { e.stopPropagation(); downloadWorkspaceFile(chatId, file.path, file.name); }}
                  className="opacity-0 group-hover:opacity-100 p-1 mr-1 text-ash-500 hover:text-ash-200 transition-all flex-shrink-0"
                  title="Download"
                >
                  <Download className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Dashboards */}
      <div className="px-3 pt-2 pb-1 border-t border-ash-800/50 flex-shrink-0">
        <span className="text-xs font-semibold text-ash-400 uppercase tracking-wide">
          Dashboards
          {panels.length > 0 && <span className="ml-1 text-ash-600">({panels.length})</span>}
        </span>
      </div>
      {panels.length === 0 ? (
        <div className="px-3 py-2 text-xs text-ash-600">No dashboards yet</div>
      ) : (
        <div className="px-2 pb-2">
          {panels.map((panel, idx) => (
            <div key={idx} className="group flex items-center w-full hover:bg-ash-800/60 transition-colors rounded">
              <button
                onClick={() => onOpenPanel(panel)}
                className="flex items-center gap-1.5 flex-1 text-left py-1 min-w-0 pl-1"
              >
                <LayoutDashboard className="w-3.5 h-3.5 text-coral-400 flex-shrink-0" />
                <span className="text-xs font-mono text-ash-300 truncate">{panel.name}</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Attachments */}
      <div className="px-3 pt-2 pb-1 border-t border-ash-800/50 flex-shrink-0">
        <span className="text-xs font-semibold text-ash-400 uppercase tracking-wide">
          Attachments
          {attachments.length > 0 && <span className="ml-1 text-ash-600">({attachments.length})</span>}
        </span>
      </div>
      {attachments.length === 0 ? (
        <div className="px-3 py-2 text-xs text-ash-600">No attachments yet</div>
      ) : (
        <div className="px-2 pb-3">
          {attachments.map((a, idx) => (
            <div key={idx} className="group flex items-center w-full hover:bg-ash-800/60 transition-colors rounded">
              <div className="flex items-center gap-1.5 flex-1 py-1 min-w-0 pl-1">
                {fileIcon(a.name)}
                <span className="text-xs font-mono text-ash-300 truncate">{a.name}</span>
              </div>
              {a.dataUrl && (
                <button
                  onClick={() => downloadAttachment(a)}
                  className="opacity-0 group-hover:opacity-100 p-1 mr-1 text-ash-500 hover:text-ash-200 transition-all flex-shrink-0"
                  title="Download"
                >
                  <Download className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main WorkspacePanel ───────────────────────────────────────────────────────
interface WorkspacePanelProps {
  chatId: string | null;
  presentedFiles: PresentedFile[];
  panels: PanelMeta[];
  attachments: MessageAttachment[];
  openFilePath?: string | null;
  openPanelName?: string | null;
  onFileOpened?: () => void;
  onPanelOpened?: () => void;
  cliWorkspaceEnabled: boolean;
  // Terminal slot props
  terminalSlots: TerminalSlotMeta[];
  activeTerminalSlot: TerminalSlotMeta | null;
  agentRunningSlot?: { kind: SlotKind; slot: number } | null;
  onSelectTerminalSlot: (slot: TerminalSlotMeta) => void;
  onOpenUserTerminalSlot: () => void;
  onCloseTerminalSlot: (slot: TerminalSlotMeta) => void;
  onDashboardPrompt?: (text: string) => void;
}

type PanelTab = 'content' | 'files';

type ActiveView =
  | { kind: 'none' }
  | { kind: 'file'; path: string; name: string }
  | { kind: 'panel'; panel: PanelMeta };

export function WorkspacePanel({
  chatId,
  presentedFiles,
  panels,
  attachments,
  openFilePath,
  openPanelName,
  onFileOpened,
  onPanelOpened,
  cliWorkspaceEnabled,
  terminalSlots,
  activeTerminalSlot,
  agentRunningSlot,
  onSelectTerminalSlot,
  onOpenUserTerminalSlot,
  onCloseTerminalSlot,
  onDashboardPrompt,
}: WorkspacePanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('content');
  const [activeView, setActiveView] = useState<ActiveView>({ kind: 'none' });
  const [slotStatuses, setSlotStatuses] = useState<Record<string, 'connected' | 'disconnected'>>({});
  const [terminalHeight, setTerminalHeight] = useState(220);
  const terminalPanelRef = useRef<HTMLDivElement>(null);
  const terminalHandleRef = useRef<HTMLDivElement>(null);

  const handleSlotStatus = useCallback((kind: SlotKind, slot: number, status: 'connected' | 'disconnected') => {
    setSlotStatuses((prev) => ({ ...prev, [`${kind}:${slot}`]: status }));
  }, []);

  const handleTerminalResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();

    const panel = terminalPanelRef.current;
    if (!panel) return;

    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const parentHeight = panel.parentElement?.getBoundingClientRect().height ?? window.innerHeight;
    // 6px resize grip + 32px title bar. Dragging to the minimum naturally
    // collapses the xterm body while leaving the title bar and grip available.
    const minHeight = 38;
    const maxHeight = Math.max(minHeight, parentHeight - 120);

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextHeight = startHeight + (startY - moveEvent.clientY);
      setTerminalHeight(Math.min(maxHeight, Math.max(minHeight, nextHeight)));
    };

    const stopResizing = () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', stopResizing);
      document.removeEventListener('pointercancel', stopResizing);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', stopResizing, { once: true });
    document.addEventListener('pointercancel', stopResizing, { once: true });
  }, []);

  // Auto-open file when agent presents
  useEffect(() => {
    if (!openFilePath || !chatId) return;
    const name = openFilePath.split('/').pop() ?? openFilePath;
    setActiveView({ kind: 'file', path: openFilePath, name });
    onFileOpened?.();
  }, [openFilePath, chatId, onFileOpened]);

  // Auto-open panel when triggered from chat message card
  useEffect(() => {
    if (!openPanelName || !chatId) return;
    const panel = panels.find((p) => p.name === openPanelName);
    if (panel) {
      setActiveView({ kind: 'panel', panel });
      onPanelOpened?.();
    }
  }, [openPanelName, chatId, panels, onPanelOpened]);

  const handleCloseView = () => setActiveView({ kind: 'none' });

  const userSlotCount = terminalSlots.filter((s) => s.kind === 'user').length;
  const canOpenUserSlot = userSlotCount < 3;

  const isRunning = !!(agentRunningSlot &&
    activeTerminalSlot?.kind === agentRunningSlot.kind &&
    activeTerminalSlot?.slot === agentRunningSlot.slot);

  // Build enriched slot list with live status
  const enrichedSlots: TerminalSlotMeta[] = terminalSlots.map((s) => ({
    ...s,
    status: (slotStatuses[`${s.kind}:${s.slot}`] === 'connected' ? 'connected'
      : s.status === 'closed-inactivity' ? 'closed-inactivity'
      : 'disconnected') as TerminalSlotMeta['status'],
  }));
  const enrichedActive = activeTerminalSlot
    ? enrichedSlots.find((s) => s.kind === activeTerminalSlot.kind && s.slot === activeTerminalSlot.slot) ?? activeTerminalSlot
    : null;

  // ── Terminal panel (bottom of workspace) ──────────────────────────────────
  const terminalPanel = cliWorkspaceEnabled && chatId ? (
    <div
      ref={terminalPanelRef}
      className="relative flex flex-col flex-shrink-0 overflow-visible"
      style={{ height: terminalHeight, zIndex: 20 }}
    >
      {/* Drag handle */}
      <div
        ref={terminalHandleRef}
        onPointerDown={handleTerminalResizeStart}
        className="relative w-full flex-shrink-0 flex items-center justify-center group touch-none overflow-visible"
        style={{ height: 6, cursor: 'row-resize', background: '#252526' }}
        title="Drag to resize terminal"
      >
        <div className="rounded-full group-hover:bg-coral-400 transition-colors" style={{ width: 32, height: 2, background: '#444' }} />
      </div>

      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Terminal bar (header + dropdown) */}
        <TerminalBar
          slots={enrichedSlots}
          activeSlot={enrichedActive}
          onSelectSlot={onSelectTerminalSlot}
          onOpenUserSlot={onOpenUserTerminalSlot}
          onCloseSlot={onCloseTerminalSlot}
          canOpenUserSlot={canOpenUserSlot}
          isRunning={isRunning}
          menuAnchorRef={terminalHandleRef}
        />

        {/* Active terminal xterm */}
        {activeTerminalSlot ? (
          <TerminalSlotWidget
            key={`${activeTerminalSlot.kind}-${activeTerminalSlot.slot}`}
            chatId={chatId}
            kind={activeTerminalSlot.kind}
            slot={activeTerminalSlot.slot}
            onStatusChange={(status) => handleSlotStatus(activeTerminalSlot.kind, activeTerminalSlot.slot, status)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs" style={{ color: '#555', background: '#1e1e1e' }}>
            No terminal open — use + to open one
          </div>
        )}
      </div>
    </div>
  ) : null;

  if (!chatId) {
    return (
      <div className="h-full w-full bg-ash-950 border-l border-ash-800 flex items-center justify-center p-6">
        <div className="max-w-xs text-center text-sm text-ash-500">
          Start or Select a Conversation to Open a Workspace
        </div>
      </div>
    );
  }

  const tabs: { id: PanelTab; label: string }[] = [
    { id: 'content', label: 'Content' },
    ...(cliWorkspaceEnabled ? [{ id: 'files' as PanelTab, label: 'Files' }] : []),
  ];

  const isViewOpen = activeView.kind !== 'none';

  return (
    <div className="flex flex-col h-full bg-ash-900 border-l border-ash-800">

      {/* File editor view */}
      {activeView.kind === 'file' && (
        <>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-ash-800 flex-shrink-0">
            <button onClick={handleCloseView} className="text-xs text-ash-500 hover:text-ash-300 transition-colors">
              ← Workspace
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <div className="flex flex-col h-full">
              <div className="flex-1 overflow-hidden min-h-0">
                <FileEditor chatId={chatId} path={activeView.path} />
              </div>
              {terminalPanel}
            </div>
          </div>
        </>
      )}

      {/* Dashboard viewer */}
      {activeView.kind === 'panel' && (
        <PanelViewer chatId={chatId} name={activeView.panel.name} onClose={handleCloseView} onSendPrompt={onDashboardPrompt} />
      )}

      {/* Tab view */}
      {!isViewOpen && (
        <>
          <div className="flex border-b border-ash-800 flex-shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
                  activeTab === tab.id
                    ? 'border-coral-500 text-coral-400'
                    : 'border-transparent text-ash-500 hover:text-ash-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-hidden min-h-0">
              {activeTab === 'content' && (
                <ContentTab
                  chatId={chatId}
                  presentedFiles={presentedFiles}
                  panels={panels}
                  attachments={attachments}
                  onOpenFile={(path, name) => setActiveView({ kind: 'file', path, name })}
                  onOpenPanel={(panel) => setActiveView({ kind: 'panel', panel })}
                />
              )}
              {activeTab === 'files' && cliWorkspaceEnabled && (
                <FileBrowser
                  key={chatId}
                  chatId={chatId}
                  onOpenFile={(path) => setActiveView({ kind: 'file', path, name: path.split('/').pop() ?? path })}
                />
              )}
            </div>
            {terminalPanel}
          </div>
        </>
      )}
    </div>
  );
}
