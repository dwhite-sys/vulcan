import { useState, useEffect, useRef, useCallback } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { ArrowLeft, History, RotateCcw, AlertTriangle, Eye, Code, FileCode, TextSelect, Copy } from 'lucide-react';
import { FileTimeline } from './FileTimeline';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ImageViewer } from './ImageViewer';
import type { TimelineEntry } from '../types/vulcan';
import {
  readFile,
  writeFile,
  gitShow,
  getSnapshotContent,
  gitCommit,
  gitRestoreFile,
  saveSnapshot,
  hasChangedSinceLastCommit,
} from '../services/vulcan';

// Detect Monaco language from file extension
function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python',
    md: 'markdown',
    json: 'json',
    yml: 'yaml', yaml: 'yaml',
    sh: 'shell',
    html: 'html',
    css: 'css',
    rs: 'rust',
    go: 'go',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    c: 'c',
    java: 'java',
    rb: 'ruby',
    sql: 'sql',
    toml: 'ini',
    txt: 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}

interface FileEditorProps {
  chatId: string;
  path: string;
  onClose?: () => void;
}

type Mode = 'edit' | 'history' | 'diff';

export function FileEditor({ chatId, path, onClose }: FileEditorProps) {
  const filename = path.split('/').pop() ?? path;
  const language = detectLanguage(filename);
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const isMarkdown = ['md', 'markdown'].includes(extension);
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'].includes(extension);

  const [mode, setMode] = useState<Mode>('edit');
  const [mdPreview, setMdPreview] = useState(false); // markdown preview toggle
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>(''); // for diff: the historical version
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<TimelineEntry | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number; y: number; text: string; startLine: number; endLine: number;
    startColumn: number; endColumn: number; revision?: string; editor: any;
  } | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedContent = useRef<string>('');
  const editorRef = useRef<any>(null);
  const selectionDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const selectedEntryRef = useRef<TimelineEntry | null>(null);
  const mountKeyRef = useRef<number>(0);
  selectedEntryRef.current = selectedEntry;

  useEffect(() => () => {
    for (const disposable of selectionDisposablesRef.current) disposable.dispose();
  }, []);

  useEffect(() => {
    const remove = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; path?: string; chatId?: string }>).detail;
      if (!detail?.id || detail.path !== path || detail.chatId !== chatId) return;
      const collections: Map<string, any> | undefined = editorRef.current?.__vulcanReferenceCollections;
      collections?.get(detail.id)?.clear?.();
      collections?.delete(detail.id);
    };
    window.addEventListener('vulcan:file-reference-remove', remove);
    return () => window.removeEventListener('vulcan:file-reference-remove', remove);
  }, [chatId, path]);

  useEffect(() => {
    if (!selectionMenu) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.vulcan-file-selection-menu')) return;
      setSelectionMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectionMenu(null); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape);
    };
  }, [selectionMenu]);

  const connectSelectionMenu = (editor: any, historical: boolean) => {
    const update = () => {
      const selection = editor.getSelection?.();
      const model = editor.getModel?.();
      if (!selection || selection.isEmpty() || !model) return;
      const text = model.getValueInRange(selection);
      if (!text.trim()) return;
      const endPosition = selection.getEndPosition();
      const visible = editor.getScrolledVisiblePosition(endPosition);
      const bounds = editor.getDomNode()?.getBoundingClientRect();
      if (!visible || !bounds) return;
      const start = selection.getStartPosition();
      const endLine = endPosition.column === 1 && endPosition.lineNumber > start.lineNumber
        ? endPosition.lineNumber - 1 : endPosition.lineNumber;
      const entry = selectedEntryRef.current;
      setSelectionMenu({
        x: Math.max(8, Math.min(bounds.left + visible.left, window.innerWidth - 250)),
        y: Math.max(8, Math.min(bounds.top + visible.top + visible.height + 5, window.innerHeight - 160)),
        text,
        startLine: start.lineNumber,
        endLine,
        startColumn: start.column,
        endColumn: endPosition.column,
        ...(historical && entry?.kind === 'commit' ? { revision: entry.commit.hash } : {}),
        editor,
      });
    };
    selectionDisposablesRef.current.push(editor.onMouseUp(() => update()));
    selectionDisposablesRef.current.push(editor.onKeyUp(() => update()));
    selectionDisposablesRef.current.push(editor.onDidScrollChange(() => setSelectionMenu(null)));
  };

  const attachReference = (includeSelection: boolean) => {
    if (!selectionMenu) return;
    const id = `reference-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    const selection = selectionMenu.editor.getSelection?.();
    if (includeSelection && selection && !selectionMenu.revision) {
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '-');
      const collections: Map<string, any> = selectionMenu.editor.__vulcanReferenceCollections ?? new Map();
      selectionMenu.editor.__vulcanReferenceCollections = collections;
      collections.get(id)?.clear?.();
      const collection = selectionMenu.editor.createDecorationsCollection([{
        range: selection,
        options: {
          inlineClassName: `vulcan-file-reference-highlight vulcan-context-target-${safeId}`,
          stickiness: 1,
        },
      }]);
      collections.set(id, collection);
    }
    window.dispatchEvent(new CustomEvent('vulcan:file-reference', {
      detail: {
        id,
        chatId,
        path,
        ...(includeSelection ? {
          startLine: selectionMenu.startLine,
          endLine: selectionMenu.endLine,
          startColumn: selectionMenu.startColumn,
          endColumn: selectionMenu.endColumn,
          selectedText: selectionMenu.text.slice(0, 240),
        } : {}),
        ...(selectionMenu.revision ? { revision: selectionMenu.revision } : {}),
      },
    }));
    setSelectionMenu(null);
  };

  // Load file content
  const loadContent = useCallback(async () => {
    if (!chatId) return;
    if (isImage) {
      setContent('');
      lastSavedContent.current = '';
      setExternalChange(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const text = await readFile(chatId, path);
      setContent(text);
      lastSavedContent.current = text;
      mountKeyRef.current += 1;
      setExternalChange(false);
    } catch (e) {
      console.error('[FileEditor] Load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [chatId, path, isImage]);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  // Save to disk + conditionally commit
  const save = useCallback(async (text: string) => {
    if (text === lastSavedContent.current) return;
    if (!chatId) {
      console.warn('[FileEditor] Cannot save — chatId is null');
      return;
    }
    setSaving(true);
    try {
      await writeFile(chatId, path, text);
      lastSavedContent.current = text;
      // Take a local snapshot
      await saveSnapshot(chatId, path).catch(() => {});
      // Git commit if changed
      const changed = await hasChangedSinceLastCommit(chatId, path);
      if (changed) {
        await gitCommit(chatId, `[user] saved ${filename}`, [path]).catch(() => {});
      }
    } catch (e) {
      console.error('[FileEditor] Save failed:', e);
    } finally {
      setSaving(false);
    }
  }, [chatId, path, filename]);

  // Flush any pending debounced save on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        const text = editorRef.current?.getValue();
        if (text !== undefined) save(text);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave on content change
  const handleEditorChange = (value: string | undefined) => {
    const text = value ?? '';
    setContent(text);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => save(text), 1000);
  };

  // Ctrl+S / Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isImage && (e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        const text = editorRef.current?.getValue() ?? content;
        save(text);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [content, save, isImage]);

  // Handle timeline entry selection — load historical content for diff
  const handleSelectEntry = async (entry: TimelineEntry) => {
    setSelectedEntry(entry);
    let historicalContent = '';
    if (entry.kind === 'commit') {
      historicalContent = await gitShow(chatId, entry.commit.hash, path);
    } else {
      historicalContent = await getSnapshotContent(chatId, entry.snapshot.id, path);
    }
    setOriginalContent(historicalContent);
    setMode('diff');
  };

  // Restore to a historical version
  const handleRestore = async () => {
    if (!selectedEntry) return;
    if (!confirm('Restore this version? Your current content will be committed first.')) return;

    // Commit current state before restoring
    await save(content);

    if (selectedEntry.kind === 'commit') {
      await gitRestoreFile(chatId, selectedEntry.commit.hash, path);
    }
    // For snapshots: write the snapshot content as a new file version
    else {
      await writeFile(chatId, path, originalContent);
      await gitCommit(chatId, `[user] restored ${filename} from snapshot`, [path]);
    }

    await loadContent();
    setMode('edit');
    setSelectedEntry(null);
  };

  const handleBack = () => {
    setMode(mode === 'diff' ? 'history' : 'edit');
    if (mode === 'diff') setSelectedEntry(null);
  };

  return (
    <div className="flex flex-col h-full bg-ash-950" data-vulcan-workspace-file={path}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-ash-800 bg-ash-900 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {mode !== 'edit' && (
            <button
              onClick={handleBack}
              className="p-1 hover:bg-ash-800 rounded transition-colors text-ash-400 hover:text-ash-200"
              title="Back"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-xs font-mono text-ash-200 truncate">{filename}</span>
          {mode === 'diff' && selectedEntry && (
            <span className="text-xs text-ash-500 truncate">
              — {selectedEntry.kind === 'commit'
                ? selectedEntry.commit.message
                : 'Autosave'}
            </span>
          )}
          {saving && <span className="text-xs text-ash-600">Saving…</span>}
          {externalChange && (
            <div className="flex items-center gap-1 text-xs text-yellow-400">
              <AlertTriangle className="w-3 h-3" />
              <span>Changed externally</span>
              <button
                onClick={loadContent}
                className="underline hover:no-underline"
              >
                Reload
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {mode === 'diff' && (
            <button
              onClick={handleRestore}
              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-coral-500/20 text-coral-400 hover:bg-coral-500/30 rounded transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Restore
            </button>
          )}
          {mode === 'edit' && isMarkdown && (
            <button
              onClick={() => setMdPreview((v) => !v)}
              className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
                mdPreview
                  ? 'bg-coral-500/20 text-coral-400 hover:bg-coral-500/30'
                  : 'bg-ash-800 hover:bg-ash-700 text-ash-400 hover:text-ash-200'
              }`}
              title={mdPreview ? 'Switch to editor' : 'Preview markdown'}
            >
              {mdPreview ? <Code className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              {mdPreview ? 'Edit' : 'Preview'}
            </button>
          )}
          {mode === 'edit' && !isImage && (
            <button
              onClick={() => setMode('history')}
              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-ash-800 hover:bg-ash-700 text-ash-400 hover:text-ash-200 rounded transition-colors"
            >
              <History className="w-3 h-3" />
              History
            </button>
          )}
          {mode === 'history' && (
            <button
              onClick={() => setMode('edit')}
              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-ash-800 hover:bg-ash-700 text-ash-400 hover:text-ash-200 rounded transition-colors"
            >
              <ArrowLeft className="w-3 h-3" />
              Back
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {mode === 'edit' && isImage ? (
          <ImageViewer chatId={chatId} path={path} />
        ) : loading ? (
          <div className="flex items-center justify-center h-full text-xs text-ash-500">
            Loading…
          </div>
        ) : mode === 'history' ? (
          <FileTimeline
            chatId={chatId}
            path={path}
            onSelectEntry={handleSelectEntry}
          />
        ) : mode === 'diff' ? (
          <DiffEditor
            original={originalContent}
            modified={content}
            language={language}
            theme="vs-dark"
            onMount={(editor) => {
              for (const disposable of selectionDisposablesRef.current) disposable.dispose();
              selectionDisposablesRef.current = [];
              connectSelectionMenu(editor.getOriginalEditor(), true);
              connectSelectionMenu(editor.getModifiedEditor(), false);
            }}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              renderSideBySide: true,
            }}
          />
        ) : mode === 'edit' && isMarkdown && mdPreview ? (
          <div className="h-full overflow-y-auto p-4">
            <MarkdownRenderer content={content} />
          </div>
        ) : mode === 'edit' ? (
          <Editor
            key={`${chatId}:${path}:${mountKeyRef.current}`}
            path={`file:///${chatId}/${path}/${mountKeyRef.current}`}
            defaultValue={content}
            language={language}
            theme="vs-dark"
            onMount={(editor) => {
              editorRef.current = editor;
              for (const disposable of selectionDisposablesRef.current) disposable.dispose();
              selectionDisposablesRef.current = [];
              connectSelectionMenu(editor, false);
            }}
            onChange={handleEditorChange}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: language === 'markdown' ? 'on' : 'off',
              renderWhitespace: 'none',
              tabSize: 2,
            }}
          />
        ) : null}
      </div>
      {selectionMenu && (
        <div
          className="vulcan-quote-context-menu vulcan-file-selection-menu"
          style={{ left: selectionMenu.x, top: selectionMenu.y }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <div className="vulcan-quote-context-preview">{selectionMenu.text}</div>
          <button type="button" onClick={() => attachReference(true)}>
            <TextSelect className="h-3.5 w-3.5" /> Attach selection
          </button>
          <button type="button" onClick={() => attachReference(false)}>
            <FileCode className="h-3.5 w-3.5" /> Attach file
          </button>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(selectionMenu.text); setSelectionMenu(null); }}>
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
        </div>
      )}
    </div>
  );
}
