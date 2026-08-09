import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { Folder, FileText, FileCode, Image, File, RefreshCw, ChevronRight, ChevronDown, FolderOpen, FolderPlus, FilePlus, Download, Trash2 } from 'lucide-react';
import { listFiles, readFileBase64, writeFile, createDirectory, renamePath, deletePath, downloadFolder, getWorkspacePath, uploadWorkspaceFile, isTransferCancelledError, prepareWorkspaceExport, readWorkspaceExportChunk, finishWorkspaceExport, cancelWorkspaceExport } from '../services/vulcan';
import type { PreparedWorkspaceExport } from '../services/vulcan';

interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
}

type FileDropHint = 'before' | 'after' | 'inside' | null;
type WorkspaceOrder = Record<string, string[]>;

function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function childName(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function orderTree(nodes: FileNode[], order: WorkspaceOrder, parent = ''): FileNode[] {
  const preferred = order[parent] ?? [];
  const rank = new Map(preferred.map((name, i) => [name, i]));
  const sorted = [...nodes].sort((a, b) => {
    const ar = rank.get(a.name);
    const br = rank.get(b.name);
    if (ar != null && br != null) return ar - br;
    if (ar != null) return -1;
    if (br != null) return 1;
    return a.name.localeCompare(b.name);
  });
  return sorted.map((node) => node.isDir
    ? { ...node, children: orderTree(node.children ?? [], order, node.path) }
    : node);
}

function buildTree(paths: string[]): FileNode[] {
  const root: FileNode[] = [];
  const map = new Map<string, FileNode>();

  const ensureDir = (fullPath: string, name: string, nodes: FileNode[]): FileNode => {
    if (!map.has(fullPath)) {
      const node: FileNode = { name, path: fullPath, isDir: true, children: [] };
      map.set(fullPath, node);
      nodes.push(node);
    }
    return map.get(fullPath)!;
  };

  for (const rawPath of paths.sort()) {
    const isExplicitDir = rawPath.endsWith('/');
    const path = isExplicitDir ? rawPath.slice(0, -1) : rawPath;
    const parts = path.split('/');

    let nodes = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const fullPath = parts.slice(0, i + 1).join('/');
      const isLast = i === parts.length - 1;

      if (isLast && !isExplicitDir) {
        if (!map.has(fullPath)) {
          const node: FileNode = { name, path: fullPath, isDir: false };
          map.set(fullPath, node);
          nodes.push(node);
        }
      } else {
        const dir = ensureDir(fullPath, name, nodes);
        nodes = dir.children!;
      }
    }
  }

  return root;
}

function fileIcon(name: string, isDir: boolean) {
  if (isDir) return <Folder className="w-3.5 h-3.5 text-coral-400 flex-shrink-0" />;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'txt'].includes(ext)) return <FileText className="w-3.5 h-3.5 text-ash-400 flex-shrink-0" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <Image className="w-3.5 h-3.5 text-coral-400 flex-shrink-0" />;
  if (['py', 'ts', 'tsx', 'js', 'jsx', 'json', 'yml', 'yaml', 'sh', 'rs', 'go'].includes(ext))
    return <FileCode className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />;
  return <File className="w-3.5 h-3.5 text-ash-500 flex-shrink-0" />;
}

async function downloadFile(chatId: string, path: string, name: string) {
  try {
    const { base64, mimeType } = await readFileBase64(chatId, path);
    const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  } catch { /* ignore */ }
}

// ── Delete confirmation modal ─────────────────────────────────────────────────

interface DeleteModalProps {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteModal({ name, onConfirm, onCancel }: DeleteModalProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-ash-900 border border-ash-700 rounded-xl shadow-2xl px-6 py-5 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-ash-200 mb-5">
          Are you sure you'd like to remove <span className="font-mono text-ash-100 font-semibold">{name}</span>?
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-md bg-ash-800 hover:bg-ash-700 text-ash-300 transition-colors"
          >
            No
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className="px-3 py-1.5 text-xs rounded-md bg-red-600 hover:bg-red-500 text-white transition-colors"
          >
            Yes
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Context menu ──────────────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  node: FileNode;
  chatId: string;
  onRename: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onClose: () => void;
}

function ContextMenu({ x, y, node, onRename, onDelete, onDownload, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Clamp to viewport
  const style: React.CSSProperties = { position: 'fixed', top: y, left: x, zIndex: 60 };

  return (
    <div
      ref={ref}
      style={style}
      className="bg-ash-850 border border-ash-700 rounded-lg shadow-xl py-1 min-w-[140px] text-xs"
    >
      {[
        { label: 'Rename', action: onRename },
        { label: 'Download', action: onDownload },
        { label: 'Delete', action: onDelete, danger: true },
      ].map(({ label, action, danger }) => (
        <button
          key={label}
          onClick={() => { action(); onClose(); }}
          className={`w-full text-left px-3 py-1.5 transition-colors ${
            danger
              ? 'text-red-400 hover:bg-red-900/30'
              : 'text-ash-300 hover:bg-ash-700/60'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Inline rename input ───────────────────────────────────────────────────────

interface RenameInputProps {
  node: FileNode;
  onCommit: (newName: string) => void;
  onCancel: () => void;
}

function RenameInput({ node, onCommit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(node.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select everything except the extension for files; whole name for dirs
    if (!node.isDir) {
      const dotIdx = node.name.lastIndexOf('.');
      el.setSelectionRange(0, dotIdx > 0 ? dotIdx : node.name.length);
    } else {
      el.select();
    }
  }, [node]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== node.name) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 min-w-0 bg-ash-700 text-ash-100 text-xs font-mono px-1 py-0 rounded outline-none ring-1 ring-coral-500"
    />
  );
}

// ── FileNodeRow ───────────────────────────────────────────────────────────────

interface FileNodeRowProps {
  node: FileNode;
  depth: number;
  chatId: string;
  renamingPath: string | null;
  dropTarget: { path: string; hint: FileDropHint } | null;
  onOpenFile: (path: string) => void;
  onRenameStart: (node: FileNode) => void;
  onRenameCommit: (node: FileNode, newName: string) => void;
  onRenameCancel: () => void;
  onDeleteRequest: (node: FileNode) => void;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  onDragPrepare: (node: FileNode) => void;
  onDragStart: (e: React.DragEvent, node: FileNode) => void;
  onDragOver: (e: React.DragEvent, node: FileNode) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, node: FileNode) => void;
  onDragEnd: () => void;
}

function FileNodeRow({
  node, depth, chatId, renamingPath, dropTarget,
  onOpenFile, onRenameStart, onRenameCommit, onRenameCancel,
  onDeleteRequest, onContextMenu, onDragPrepare, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}: FileNodeRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isRenaming = renamingPath === node.path;
  const dropHint = dropTarget?.path === node.path ? dropTarget.hint : null;

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.isDir) downloadFolder(chatId, node.path, node.name);
    else downloadFile(chatId, node.path, node.name);
  };

  return (
    <>
      <div
        draggable={!isRenaming}
        onDragStart={(e) => onDragStart(e, node)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => onDragOver(e, node)}
        onDragLeave={onDragLeave}
        onDrop={(e) => onDrop(e, node)}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={`group relative flex items-center w-full transition-colors rounded ${
          dropHint === 'inside'
            ? 'bg-coral-500/20 ring-1 ring-coral-500/50'
            : 'hover:bg-ash-800/60'
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {dropHint === 'before' && <div className="absolute left-1 right-1 top-0 h-0.5 bg-coral-500 rounded-full" />}
        {dropHint === 'after' && <div className="absolute left-1 right-1 bottom-0 h-0.5 bg-coral-500 rounded-full" />}
        <button
          onClick={() => {
            if (isRenaming) return;
            if (node.isDir) setExpanded((v) => !v);
            else onOpenFile(node.path);
          }}
          onDoubleClick={(e) => { e.preventDefault(); onRenameStart(node); }}
          className="flex items-center gap-1.5 flex-1 text-left py-1 min-w-0"
        >
          {node.isDir && (
            expanded
              ? <ChevronDown className="w-3 h-3 text-ash-600 flex-shrink-0" />
              : <ChevronRight className="w-3 h-3 text-ash-600 flex-shrink-0" />
          )}
          {!node.isDir && <span className="w-3 flex-shrink-0" />}
          {fileIcon(node.name, node.isDir)}
          {isRenaming ? (
            <RenameInput
              node={node}
              onCommit={(newName) => onRenameCommit(node, newName)}
              onCancel={onRenameCancel}
            />
          ) : (
            <span className="text-xs font-mono text-ash-300 truncate">{node.name}</span>
          )}
        </button>

        {/* Hover action buttons */}
        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
          <button
            onClick={handleDownload}
            className="p-1 text-ash-500 hover:text-ash-200 transition-colors"
            title={node.isDir ? 'Download as zip' : 'Download'}
          >
            <Download className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteRequest(node); }}
            className="p-1 mr-1 text-ash-500 hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {node.isDir && expanded && node.children?.map((child) => (
        <FileNodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          chatId={chatId}
          renamingPath={renamingPath}
          dropTarget={dropTarget}
          onOpenFile={onOpenFile}
          onRenameStart={onRenameStart}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
          onDeleteRequest={onDeleteRequest}
          onContextMenu={onContextMenu}
          onDragPrepare={onDragPrepare}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
        />
      ))}
    </>
  );
}

// ── FileBrowser ───────────────────────────────────────────────────────────────

interface FileBrowserProps {
  chatId: string;
  onOpenFile: (path: string) => void;
}

export function FileBrowser({ chatId, onOpenFile }: FileBrowserProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const orderStorageKey = `vulcan-workspace-order:${chatId}`;
  const [workspaceOrder, setWorkspaceOrder] = useState<WorkspaceOrder>(() => {
    try { return JSON.parse(localStorage.getItem(`vulcan-workspace-order:${chatId}`) ?? '{}'); }
    catch { return {}; }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Rename state
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<FileNode | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);

  // Drag state
  const [dropTarget, setDropTarget] = useState<{ path: string; hint: FileDropHint } | null>(null);
  const dragSrcPath = useRef<string | null>(null);
  const dragSrcIsDir = useRef(false);
  const nativeDragSourcePath = useRef<string | null>(null);
  const nativeDragSourceIsDir = useRef(false);
  const nativeExportPromise = useRef<Promise<PreparedWorkspaceExport> | null>(null);
  const nativeExportReady = useRef<PreparedWorkspaceExport | null>(null);
  const nativeExportPath = useRef<string | null>(null);
  const cancelledTransferIds = useRef(new Set<string>());
  const fileTreeDropZoneRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const files = await listFiles(chatId);
      setTree(orderTree(buildTree(files), workspaceOrder));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [chatId, workspaceOrder]);

  useEffect(() => {
    localStorage.setItem(orderStorageKey, JSON.stringify(workspaceOrder));
  }, [orderStorageKey, workspaceOrder]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [load]);


  useEffect(() => {
    const handler = (event: Event) => {
      const id = String((event as CustomEvent).detail?.id ?? '');
      if (id) cancelledTransferIds.current.add(id);
    };
    window.addEventListener('vulcan-transfer-cancel', handler);
    return () => window.removeEventListener('vulcan-transfer-cancel', handler);
  }, []);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onNativeFileDragEnd) return;
    return api.onNativeFileDragEnd(() => {
      nativeDragSourcePath.current = null;
      nativeDragSourceIsDir.current = false;
      nativeExportPromise.current = null;
      nativeExportReady.current = null;
      nativeExportPath.current = null;
      setDropTarget(null);
    });
  }, []);

  // ── Create ──────────────────────────────────────────────────────────────────

  const nextRootName = useCallback(async (base: string) => {
    const files = await listFiles(chatId);
    const rootNames = new Set(files.map((path) => path.replace(/\/$/, '').split('/')[0]));
    if (!rootNames.has(base)) return base;
    let i = 2;
    while (rootNames.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }, [chatId]);

  const handleNewFile = async () => {
    try {
      const name = await nextRootName('New File');
      await writeFile(chatId, name, '');
      await load();
      setRenamingPath(name);
    } catch { /* ignore */ }
  };

  const handleNewFolder = async () => {
    try {
      const name = await nextRootName('New Folder');
      await createDirectory(chatId, name);
      await load();
      setRenamingPath(name);
    } catch { /* ignore */ }
  };

  // ── Rename ──────────────────────────────────────────────────────────────────

  const handleRenameStart = (node: FileNode) => setRenamingPath(node.path);
  const handleRenameCancel = () => setRenamingPath(null);

  const migrateOrderPath = useCallback((order: WorkspaceOrder, oldPath: string, newPath: string) => {
    const next: WorkspaceOrder = {};
    for (const [key, names] of Object.entries(order)) {
      const migratedKey = key === oldPath || key.startsWith(oldPath + '/')
        ? newPath + key.slice(oldPath.length)
        : key;
      next[migratedKey] = [...names];
    }
    return next;
  }, []);

  const handleRenameCommit = async (node: FileNode, newName: string) => {
    setRenamingPath(null);
    const parent = parentPath(node.path);
    const toPath = parent ? `${parent}/${newName}` : newName;
    try {
      await renamePath(chatId, node.path, toPath);
      setWorkspaceOrder((current) => {
        const next = migrateOrderPath(current, node.path, toPath);
        const names = [...(next[parent] ?? [])];
        const idx = names.indexOf(node.name);
        if (idx >= 0) names[idx] = newName;
        next[parent] = names;
        return next;
      });
    } catch { /* ignore — server will 409 if dest exists */ }
  };

  // ── Delete ──────────────────────────────────────────────────────────────────

  const handleDeleteRequest = (node: FileNode) => {
    setContextMenu(null);
    setDeleteTarget(node);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deletePath(chatId, target.path);
      setWorkspaceOrder((current) => {
        const next: WorkspaceOrder = {};
        for (const [key, names] of Object.entries(current) as Array<[string, string[]]>) {
          if (key === target.path || key.startsWith(target.path + '/')) continue;
          next[key] = key === parentPath(target.path)
            ? names.filter((name) => name !== target.name)
            : [...names];
        }
        return next;
      });
    } catch { /* ignore */ }
  };

  // ── Context menu ────────────────────────────────────────────────────────────

  const handleContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  // ── Drag and drop ────────────────────────────────────────────────────────────

  const siblingNames = useCallback((parent: string): string[] => {
    const walk = (nodes: FileNode[], currentParent: string): string[] | null => {
      if (currentParent === parent) return nodes.map((n) => n.name);
      for (const node of nodes) {
        if (!node.isDir) continue;
        const found = walk(node.children ?? [], node.path);
        if (found) return found;
      }
      return null;
    };
    return walk(tree, '') ?? [];
  }, [tree]);

  const handleDragPrepare = (node: FileNode) => {
    if (nativeExportPath.current === node.path && nativeExportPromise.current) return;
    const previousReady = nativeExportReady.current;
    if (previousReady) void cancelWorkspaceExport(previousReady.exportId).catch(() => {});
    nativeExportPath.current = node.path;
    nativeExportReady.current = null;
    const promise = prepareWorkspaceExport(chatId, node.path);
    nativeExportPromise.current = promise;
    void promise.then((prepared) => {
      if (nativeExportPath.current === node.path) nativeExportReady.current = prepared;
      else void cancelWorkspaceExport(prepared.exportId).catch(() => {});
    }).catch(() => {
      if (nativeExportPath.current === node.path) nativeExportReady.current = null;
    });
  };

  const handleDragStart = (e: React.DragEvent, node: FileNode) => {
    if (renamingPath === node.path) { e.preventDefault(); return; }
    dragSrcPath.current = node.path;
    dragSrcIsDir.current = node.isDir;
    if (nativeExportPath.current !== node.path || !nativeExportPromise.current) handleDragPrepare(node);

    // Keep the browser drag alive for workspace reordering. Crossing out of the
    // file section promotes it to the prepared native OS export.
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.path);
  };

  const handleDragEnd = () => {
    dragSrcPath.current = null;
    dragSrcIsDir.current = false;
    if (!nativeDragSourcePath.current) {
      const ready = nativeExportReady.current;
      if (ready) void cancelWorkspaceExport(ready.exportId).catch(() => {});
      nativeExportPromise.current = null;
      nativeExportReady.current = null;
      nativeExportPath.current = null;
    }
    setDropTarget(null);
  };

  const currentDragSource = () => dragSrcPath.current ?? nativeDragSourcePath.current;
  const currentDragSourceIsDir = () => dragSrcPath.current ? dragSrcIsDir.current : nativeDragSourceIsDir.current;

  const canMoveToParent = (src: string, targetParent: string) =>
    !currentDragSourceIsDir() || (targetParent !== src && !targetParent.startsWith(src + '/'));

  const beginNativeDrag = async () => {
    const src = dragSrcPath.current;
    const api = (window as any).electronAPI;
    if (!src || !api?.prepareNativeFileExport || nativeDragSourcePath.current) return;
    const promise = nativeExportPath.current === src ? nativeExportPromise.current : null;
    if (!promise) return;

    const displayName = childName(src) + (dragSrcIsDir.current ? '.zip' : '');
    const uiTransferId = `download:${chatId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const emitProgress = (detail: Record<string, unknown>) => {
      window.dispatchEvent(new CustomEvent('vulcan-transfer-progress', {
        detail: { id: uiTransferId, filename: displayName, direction: 'download', ...detail },
      }));
    };
    const removeProgress = () => {
      window.dispatchEvent(new CustomEvent('vulcan-transfer-progress', {
        detail: { id: uiTransferId, remove: true },
      }));
    };
    const assertNotCancelled = () => {
      if (cancelledTransferIds.current.has(uiTransferId)) throw new Error('__VULCAN_TRANSFER_CANCELLED__');
    };

    emitProgress({ preparing: true, percent: 0 });

    let prepared: PreparedWorkspaceExport | null = null;
    // Crossing out of the workspace commits this gesture to an outward export.
    // Mark it immediately so dragend does not cancel a transfer that is still
    // preparing/downloading after the pointer has left Vulcan.
    nativeDragSourcePath.current = src;
    nativeDragSourceIsDir.current = dragSrcIsDir.current;
    try {
      prepared = await promise;
      assertNotCancelled();

      // From this point onward the server's actual export filename is canonical.
      window.dispatchEvent(new CustomEvent('vulcan-transfer-progress', {
        detail: { id: uiTransferId, filename: prepared.filename, direction: 'download', preparing: false, percent: prepared.size === 0 ? 100 : 0 },
      }));

      await api.prepareNativeFileExport({ transferId: prepared.exportId, filename: prepared.filename, size: prepared.size });
      assertNotCancelled();

      let offset = 0;
      const total = Math.max(0, prepared.size);
      while (offset < total) {
        assertNotCancelled();
        const chunk = await readWorkspaceExportChunk(prepared.exportId, offset);
        assertNotCancelled();
        if (chunk.data) await api.appendNativeFileExport({ transferId: prepared.exportId, base64: chunk.data });
        offset = chunk.nextOffset;
        const percent = total > 0 ? Math.min(100, Math.round((offset / total) * 100)) : 100;
        window.dispatchEvent(new CustomEvent('vulcan-transfer-progress', {
          detail: { id: uiTransferId, filename: prepared.filename, direction: 'download', preparing: false, percent },
        }));
        if (chunk.done) break;
      }

      assertNotCancelled();
      await api.finishNativeFileExport({ transferId: prepared.exportId });
      await finishWorkspaceExport(prepared.exportId);
      removeProgress();
      toast.success(`Download Complete: ${prepared.filename}`);
      api.startPreparedNativeFileDrag({ transferId: prepared.exportId });
    } catch (err) {
      const cancelled = cancelledTransferIds.current.has(uiTransferId) || String(err).includes('__VULCAN_TRANSFER_CANCELLED__');
      if (prepared) {
        await cancelWorkspaceExport(prepared.exportId).catch(() => {});
        try { await api?.cancelNativeFileExport?.({ transferId: prepared.exportId }); } catch { /* best effort */ }
      }
      nativeDragSourcePath.current = null;
      nativeDragSourceIsDir.current = false;
      removeProgress();
      if (!cancelled) console.warn('Failed to export workspace item for native drag:', err);
    } finally {
      cancelledTransferIds.current.delete(uiTransferId);
    }
  };

  const handleDragOver = (e: React.DragEvent, node: FileNode) => {
    const src = currentDragSource();
    const isExternalFileDrag = !src && Array.from(e.dataTransfer.types).includes('Files');
    if (!src && !isExternalFileDrag) return;
    if (src === node.path) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    let hint: FileDropHint;
    if (node.isDir && y >= 0.25 && y <= 0.75) hint = 'inside';
    else hint = y < 0.5 ? 'before' : 'after';

    const targetParent = hint === 'inside' ? node.path : parentPath(node.path);
    if (src && !canMoveToParent(src, targetParent)) return;

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isExternalFileDrag ? 'copy' : 'move';
    setDropTarget({ path: node.path, hint });
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropTarget(null);
  };

  const commitPlacement = async (src: string, targetParent: string, targetName: string | null, position: 'before' | 'after' | 'inside' | 'root') => {
    const srcParent = parentPath(src);
    const srcName = childName(src);
    if (!canMoveToParent(src, targetParent)) return;
    const toPath = targetParent ? `${targetParent}/${srcName}` : srcName;

    try {
      if (toPath !== src) await renamePath(chatId, src, toPath);

      setWorkspaceOrder((current) => {
        let next = migrateOrderPath(current, src, toPath);
        const sourceNames = (next[srcParent]?.length ? [...next[srcParent]] : siblingNames(srcParent)).filter((n) => n !== srcName);
        next[srcParent] = sourceNames;

        let destinationNames = targetParent === srcParent
          ? [...sourceNames]
          : (next[targetParent]?.length ? [...next[targetParent]] : siblingNames(targetParent)).filter((n) => n !== srcName);

        let insertAt = destinationNames.length;
        if (targetName && position !== 'inside' && position !== 'root') {
          const targetIndex = destinationNames.indexOf(targetName);
          if (targetIndex >= 0) insertAt = targetIndex + (position === 'after' ? 1 : 0);
        }
        destinationNames.splice(insertAt, 0, srcName);
        next[targetParent] = destinationNames;
        return next;
      });
    } catch { /* destination exists or server rejected move */ }
  };

  const commitExternalFiles = async (
    files: File[],
    targetParent: string,
    targetName: string | null,
    position: 'before' | 'after' | 'inside' | 'root',
  ) => {
    if (!files.length) return;
    const uploadedNames: string[] = [];
    const failures: string[] = [];

    for (const file of files) {
      const destPath = targetParent ? `${targetParent}/${file.name}` : file.name;
      try {
        await uploadWorkspaceFile(chatId, file, destPath);
        uploadedNames.push(file.name);
      } catch (err) {
        if (!isTransferCancelledError(err)) failures.push(`${file.name}: ${String(err)}`);
      }
    }

    if (uploadedNames.length) {
      setWorkspaceOrder((current) => {
        const next = { ...current };
        const existing = (next[targetParent]?.length ? [...next[targetParent]] : siblingNames(targetParent))
          .filter((name) => !uploadedNames.includes(name));
        let insertAt = existing.length;
        if (targetName && position !== 'inside' && position !== 'root') {
          const targetIndex = existing.indexOf(targetName);
          if (targetIndex >= 0) insertAt = targetIndex + (position === 'after' ? 1 : 0);
        }
        existing.splice(insertAt, 0, ...uploadedNames);
        next[targetParent] = existing;
        return next;
      });
      await load();
    }

    if (failures.length) setError(`Upload failed — ${failures.join('; ')}`);
  };

  const handleDrop = async (e: React.DragEvent, targetNode: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    const src = currentDragSource();
    const externalFiles = Array.from(e.dataTransfer.files ?? []);
    const hint = dropTarget?.path === targetNode.path ? dropTarget.hint : null;
    setDropTarget(null);
    dragSrcPath.current = null;
    nativeDragSourcePath.current = null;
    if (!hint) return;

    const targetParent = hint === 'inside' ? targetNode.path : parentPath(targetNode.path);
    if (src) {
      if (src !== targetNode.path) {
        await commitPlacement(src, targetParent, hint === 'inside' ? null : targetNode.name, hint);
      }
      dragSrcIsDir.current = false;
      return;
    }

    if (externalFiles.length) {
      await commitExternalFiles(externalFiles, targetParent, hint === 'inside' ? null : targetNode.name, hint);
    }
  };

  // Empty workspace-tree space is root: internal items move there, external files upload there.
  const handleRootDrop = async (e: React.DragEvent) => {
    const src = currentDragSource();
    const externalFiles = Array.from(e.dataTransfer.files ?? []);
    if (!src && !externalFiles.length) return;
    e.preventDefault();
    setDropTarget(null);
    dragSrcPath.current = null;
    nativeDragSourcePath.current = null;
    if (src) {
      await commitPlacement(src, '', null, 'root');
      dragSrcIsDir.current = false;
    } else {
      await commitExternalFiles(externalFiles, '', null, 'root');
    }
  };

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 py-2 border-b border-ash-800 flex-shrink-0">
          <span className="text-xs text-ash-500">Workspace files</span>
          <div className="flex items-center gap-1">
            <button
              onClick={handleNewFile}
              className="p-1 hover:bg-ash-800 rounded transition-colors text-ash-500 hover:text-ash-300"
              title="New file"
            >
              <FilePlus className="w-3 h-3" />
            </button>
            <button
              onClick={handleNewFolder}
              className="p-1 hover:bg-ash-800 rounded transition-colors text-ash-500 hover:text-ash-300"
              title="New folder"
            >
              <FolderPlus className="w-3 h-3" />
            </button>
            <button
              onClick={async () => {
                try {
                  const path = await getWorkspacePath(chatId);
                  const api = (window as any).electronAPI;
                  if (api?.openFolder) api.openFolder(path);
                } catch { /* not in Electron */ }
              }}
              className="p-1 hover:bg-ash-800 rounded transition-colors text-ash-500 hover:text-ash-300"
              title="Open workspace folder"
            >
              <FolderOpen className="w-3 h-3" />
            </button>
            <button
              onClick={load}
              className="p-1 hover:bg-ash-800 rounded transition-colors text-ash-500 hover:text-ash-300"
              title="Refresh"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>

        <div
          ref={fileTreeDropZoneRef}
          className="flex-1 overflow-y-auto py-1"
          onDragOver={(e) => {
            const src = currentDragSource();
            const isExternalFileDrag = !src && Array.from(e.dataTransfer.types).includes('Files');
            if (!src && !isExternalFileDrag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = isExternalFileDrag ? 'copy' : 'move';
          }}
          onDragLeave={(e) => {
            // Crossing out of the workspace file section turns the current internal
            // drag into an OS-native file drag. Moving between rows does not.
            const related = e.relatedTarget as Node | null;
            if (related && fileTreeDropZoneRef.current?.contains(related)) return;
            if (dragSrcPath.current) void beginNativeDrag();
          }}
          onDrop={handleRootDrop}
        >
          {loading && tree.length === 0 ? (
            <div className="flex items-center justify-center h-16 text-xs text-ash-600">Loading…</div>
          ) : error ? (
            <div className="px-3 py-2 text-xs text-red-400">
              {error.includes('fetch') ? 'Vulcan not reachable' : error}
            </div>
          ) : tree.length === 0 ? (
            <div className="flex items-center justify-center h-16 text-xs text-ash-600">No files yet</div>
          ) : (
            tree.map((node) => (
              <FileNodeRow
                key={node.path}
                node={node}
                depth={0}
                chatId={chatId}
                renamingPath={renamingPath}
                dropTarget={dropTarget}
                onOpenFile={onOpenFile}
                onRenameStart={handleRenameStart}
                onRenameCommit={handleRenameCommit}
                onRenameCancel={handleRenameCancel}
                onDeleteRequest={handleDeleteRequest}
                onContextMenu={handleContextMenu}
                onDragPrepare={handleDragPrepare}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              />
            ))
          )}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <DeleteModal
          name={deleteTarget.name}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          chatId={chatId}
          onRename={() => handleRenameStart(contextMenu.node)}
          onDelete={() => handleDeleteRequest(contextMenu.node)}
          onDownload={() => {
            const { node } = contextMenu;
            if (node.isDir) downloadFolder(chatId, node.path, node.name);
            else downloadFile(chatId, node.path, node.name);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
