import { useMemo, useState, useRef, useEffect } from 'react';
import { Plus, FolderPlus, Folder, MoreHorizontal, Trash2, Edit2, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import type { Chat, ChatFolder } from '../types/vulcan';
import type { ChatTerminalStatus } from '../services/vulcan';

export type SidebarDragItem = { type: 'chat' | 'folder'; id: string };

interface KitSidebarProps {
  chats: Chat[];
  folders: ChatFolder[];
  activeChat: Chat | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onNewFolder: () => void;
  onDeleteChat: (chatId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onSetFolderCollapsed: (folderId: string, collapsed: boolean) => void;
  onMoveItem: (item: SidebarDragItem, parentFolderId: string | null, index: number, expandFolderId?: string) => void;
  compact?: boolean;
  embedded?: boolean;
  emptyText?: string;
  terminalChatStatuses?: Record<string, ChatTerminalStatus>;
}

function relativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const diffWeek = Math.floor(diffDay / 7);
  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay} days ago`;
  if (diffWeek === 1) return '1 week ago';
  if (diffWeek < 5) return `${diffWeek} weeks ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function DeleteModal({
  title, noun = 'chat', detail, onConfirm, onCancel,
}: {
  title: string;
  noun?: string;
  detail?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-ash-900 border border-ash-700 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
        <h3 className="text-base font-semibold text-ash-100 mb-1">Delete {noun}?</h3>
        <p className="text-sm text-ash-400 mb-6">
          {detail ?? <>This will permanently delete <span className="font-medium text-ash-200">{title}</span>.</>}
        </p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-ash-300 bg-ash-800 hover:bg-ash-700 rounded-lg transition-colors">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">Delete</button>
        </div>
      </div>
    </div>
  );
}

function ContextMenu({ onRename, onDelete, onClose }: { onRename: () => void; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 w-40 bg-ash-900 border border-ash-700 rounded-lg shadow-xl z-40 overflow-hidden py-1">
      <button onClick={(e) => { e.stopPropagation(); onRename(); onClose(); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ash-300 hover:bg-ash-800 transition-colors"><Edit2 className="w-3.5 h-3.5" />Rename</button>
      <button onClick={(e) => { e.stopPropagation(); onDelete(); onClose(); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-ash-800 transition-colors"><Trash2 className="w-3.5 h-3.5" />Delete</button>
    </div>
  );
}

type DropHint = 'before' | 'after' | 'inside' | null;

function RowShell({
  depth, active = false, dropHint, draggable, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, onClick, children,
}: {
  depth: number; active?: boolean; dropHint: DropHint; draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void; onDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void; onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void; onClick?: () => void; children: React.ReactNode;
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onClick={onClick}
      className={`group relative min-h-[48px] rounded transition-colors cursor-pointer ${active ? 'bg-ash-800/60 text-ash-100' : 'hover:bg-ash-800/60 text-ash-300'} ${dropHint === 'inside' ? 'bg-coral-500/20 ring-1 ring-coral-500/50' : ''}`}
      style={{ paddingLeft: `${8 + depth * 14}px`, paddingRight: '8px' }}
    >
      {dropHint === 'before' && <div className="absolute left-1 right-1 top-0 h-0.5 bg-coral-500 rounded-full" />}
      {dropHint === 'after' && <div className="absolute left-1 right-1 bottom-0 h-0.5 bg-coral-500 rounded-full" />}
      {children}
    </div>
  );
}

function ChatItem({
  chat, depth, isActive, terminalStatus, dragItem, setDragItem, onSelect, onDelete, onRename, onDropAt,
}: {
  chat: Chat; depth: number; isActive: boolean; terminalStatus?: ChatTerminalStatus;
  dragItem: SidebarDragItem | null; setDragItem: (v: SidebarDragItem | null) => void;
  onSelect: () => void; onDelete: () => void; onRename: (title: string) => void;
  onDropAt: (item: SidebarDragItem, position: 'before' | 'after') => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(chat.title ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [dropHint, setDropHint] = useState<DropHint>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setEditValue(chat.title ?? ''); }, [chat.title, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  const commitRename = () => { const trimmed = editValue.trim(); if (trimmed && trimmed !== chat.title) onRename(trimmed); setEditing(false); };
  const cancelRename = () => { setEditValue(chat.title ?? ''); setEditing(false); };
  return (
    <>
      {showDeleteModal && <DeleteModal title={chat.title || 'this chat'} onConfirm={() => { setShowDeleteModal(false); onDelete(); }} onCancel={() => setShowDeleteModal(false)} />}
      <RowShell
        depth={depth} active={isActive} dropHint={dropHint} draggable={!editing}
        onClick={() => { if (!editing) onSelect(); }}
        onDragStart={(e) => { const item: SidebarDragItem = { type: 'chat', id: chat.id }; setDragItem(item); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', JSON.stringify(item)); }}
        onDragEnd={() => { setDragItem(null); setDropHint(null); }}
        onDragOver={(e) => { if (!dragItem || (dragItem.type === 'chat' && dragItem.id === chat.id)) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setDropHint(e.clientY < r.top + r.height / 2 ? 'before' : 'after'); }}
        onDragLeave={() => setDropHint(null)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragItem && dropHint) onDropAt(dragItem, dropHint as 'before' | 'after'); setDropHint(null); setDragItem(null); }}
      >
        <div className="flex items-center gap-2 min-w-0 min-h-[48px]">
          <div className="flex-1 min-w-0">
            {editing ? (
              <input ref={inputRef} value={editValue} onChange={(e) => setEditValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename(); }} onClick={(e) => e.stopPropagation()} className="w-full text-sm font-medium bg-ash-700 text-ash-100 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-coral-500" />
            ) : <h3 className="text-sm overflow-hidden whitespace-nowrap text-ellipsis max-w-full">{chat.title}</h3>}
            {!editing && <p className="text-xs text-ash-500 mt-0.5">{relativeTime(new Date(chat.updatedAt))}</p>}
          </div>
          {!editing && terminalStatus && (terminalStatus.userOpen || terminalStatus.agentOpen) && (
            <div className="terminal-status-cluster flex items-center gap-1.5 flex-shrink-0">
              {terminalStatus.userOpen && (
                <span
                  className={`terminal-status-dot terminal-status-dot-user ${terminalStatus.userBusy ? 'terminal-status-dot-active' : ''}`}
                  title={terminalStatus.userBusy ? 'User Terminal — Running' : 'User Terminal — Open'}
                  aria-label={terminalStatus.userBusy ? 'User Terminal — Running' : 'User Terminal — Open'}
                />
              )}
              {terminalStatus.agentOpen && (
                <span
                  className={`terminal-status-dot terminal-status-dot-agent ${terminalStatus.agentBusy ? 'terminal-status-dot-active' : ''}`}
                  title={terminalStatus.agentBusy ? 'Agent Terminal — Running' : 'Agent Terminal — Open'}
                  aria-label={terminalStatus.agentBusy ? 'Agent Terminal — Running' : 'Agent Terminal — Open'}
                />
              )}
            </div>
          )}
          {editing ? (
            <div className="flex items-center gap-1 flex-shrink-0">
              <button type="button" onClick={(e) => { e.stopPropagation(); commitRename(); }} className="p-1 hover:bg-ash-700 rounded" title="Save"><Check className="w-3 h-3 text-green-400" /></button>
              <button type="button" onClick={(e) => { e.stopPropagation(); cancelRename(); }} className="p-1 hover:bg-ash-700 rounded" title="Cancel"><X className="w-3 h-3 text-ash-400" /></button>
            </div>
          ) : (
            <div className="relative flex-shrink-0">
              <button type="button" onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} className={`p-1 rounded transition-all hover:bg-ash-700 ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} title="More options"><MoreHorizontal className="w-4 h-4 text-ash-400" /></button>
              {menuOpen && <ContextMenu onRename={() => setEditing(true)} onDelete={() => setShowDeleteModal(true)} onClose={() => setMenuOpen(false)} />}
            </div>
          )}
        </div>
      </RowShell>
    </>
  );
}

function FolderItem({
  folder, depth, expanded, latestTimestamp, dragItem, setDragItem, canDropInside,
  onToggle, onRename, onDelete, onDropAt, children,
}: {
  folder: ChatFolder; depth: number; expanded: boolean; latestTimestamp: Date;
  dragItem: SidebarDragItem | null; setDragItem: (v: SidebarDragItem | null) => void; canDropInside: (item: SidebarDragItem, folderId: string) => boolean;
  onToggle: () => void; onRename: (name: string) => void; onDelete: () => void;
  onDropAt: (item: SidebarDragItem, position: 'before' | 'after' | 'inside') => void; children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(folder.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [dropHint, setDropHint] = useState<DropHint>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setEditValue(folder.name); }, [folder.name, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  const commitRename = () => { const trimmed = editValue.trim(); if (trimmed && trimmed !== folder.name) onRename(trimmed); setEditing(false); };
  const cancelRename = () => { setEditValue(folder.name); setEditing(false); };
  return (
    <>
      {showDeleteModal && <DeleteModal noun="folder" title={folder.name} detail="The folder will be removed, but its chats and nested folders will be moved up one level." onConfirm={() => { setShowDeleteModal(false); onDelete(); }} onCancel={() => setShowDeleteModal(false)} />}
      <RowShell
        depth={depth} dropHint={dropHint} draggable={!editing}
        onClick={() => { if (!editing) onToggle(); }}
        onDragStart={(e) => { const item: SidebarDragItem = { type: 'folder', id: folder.id }; setDragItem(item); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', JSON.stringify(item)); }}
        onDragEnd={() => { setDragItem(null); setDropHint(null); }}
        onDragOver={(e) => {
          if (!dragItem || (dragItem.type === 'folder' && dragItem.id === folder.id)) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect(); const y = (e.clientY - r.top) / r.height;
          if (y < 0.25) setDropHint('before');
          else if (y > 0.75) setDropHint('after');
          else setDropHint(canDropInside(dragItem, folder.id) ? 'inside' : null);
        }}
        onDragLeave={() => setDropHint(null)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragItem && dropHint) onDropAt(dragItem, dropHint as 'before' | 'after' | 'inside'); setDropHint(null); setDragItem(null); }}
      >
        <div className="flex items-center gap-1.5 min-w-0 min-h-[48px]">
          {expanded ? <ChevronDown className="w-3 h-3 text-ash-600 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-ash-600 flex-shrink-0" />}
          <Folder className="w-3.5 h-3.5 text-coral-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            {editing ? (
              <input ref={inputRef} value={editValue} onChange={(e) => setEditValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename(); }} onClick={(e) => e.stopPropagation()} className="w-full text-sm font-medium bg-ash-700 text-ash-100 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-coral-500" />
            ) : <h3 className="text-sm overflow-hidden whitespace-nowrap text-ellipsis max-w-full">{folder.name}</h3>}
            {!editing && <p className="text-xs text-ash-500 mt-0.5">{relativeTime(latestTimestamp)}</p>}
          </div>
          {editing ? (
            <div className="flex items-center gap-1 flex-shrink-0">
              <button type="button" onClick={(e) => { e.stopPropagation(); commitRename(); }} className="p-1 hover:bg-ash-700 rounded" title="Save"><Check className="w-3 h-3 text-green-400" /></button>
              <button type="button" onClick={(e) => { e.stopPropagation(); cancelRename(); }} className="p-1 hover:bg-ash-700 rounded" title="Cancel"><X className="w-3 h-3 text-ash-400" /></button>
            </div>
          ) : (
            <div className="relative flex-shrink-0">
              <button type="button" onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} className={`p-1 rounded transition-all hover:bg-ash-700 ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} title="More options"><MoreHorizontal className="w-4 h-4 text-ash-400" /></button>
              {menuOpen && <ContextMenu onRename={() => setEditing(true)} onDelete={() => setShowDeleteModal(true)} onClose={() => setMenuOpen(false)} />}
            </div>
          )}
        </div>
      </RowShell>
      {expanded && children}
    </>
  );
}

export function KitSidebar({
  chats, folders, activeChat, onSelectChat, onNewChat, onNewFolder, onDeleteChat, onRenameChat,
  onRenameFolder, onDeleteFolder, onSetFolderCollapsed, onMoveItem, compact = false, embedded = false, emptyText = 'No chats yet',
  terminalChatStatuses = {},
}: KitSidebarProps) {
  const [dragItem, setDragItem] = useState<SidebarDragItem | null>(null);
  const chatIndex = useMemo(() => new Map(chats.map((c, i) => [c.id, i])), [chats]);
  const folderIndex = useMemo(() => new Map(folders.map((f, i) => [f.id, i])), [folders]);

  const childrenOf = (parentId: string | null) => {
    const items: Array<{ type: 'chat' | 'folder'; id: string; order?: number; fallback: number }> = [];
    folders.forEach((f) => { if ((f.parentId ?? null) === parentId) items.push({ type: 'folder', id: f.id, order: f.sidebarOrder, fallback: folderIndex.get(f.id) ?? 0 }); });
    chats.forEach((c) => { if ((c.folderId ?? null) === parentId) items.push({ type: 'chat', id: c.id, order: c.sidebarOrder, fallback: chatIndex.get(c.id) ?? 0 }); });
    return items.sort((a, b) => {
      const ao = a.order ?? Number.MAX_SAFE_INTEGER; const bo = b.order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      if (a.type === b.type) return a.fallback - b.fallback;
      // Legacy unordered entries preserve the server's chat-recency order while keeping folders stable.
      return a.fallback - b.fallback;
    });
  };

  const folderLatestChatTimestamp = (folderId: string, seen = new Set<string>()): Date | null => {
    if (seen.has(folderId)) return null;
    const nextSeen = new Set(seen); nextSeen.add(folderId);
    let latest: Date | null = null;
    chats.filter((c) => (c.folderId ?? null) === folderId).forEach((c) => {
      const d = new Date(c.updatedAt);
      if (!latest || d > latest) latest = d;
    });
    folders.filter((f) => (f.parentId ?? null) === folderId).forEach((child) => {
      const d = folderLatestChatTimestamp(child.id, nextSeen);
      if (d && (!latest || d > latest)) latest = d;
    });
    return latest;
  };

  const folderTimestamp = (folder: ChatFolder): Date =>
    folderLatestChatTimestamp(folder.id) ?? new Date(folder.createdAt);

  const isFolderDescendantOf = (folderId: string, possibleAncestorId: string): boolean => {
    let current = folders.find((f) => f.id === folderId);
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id)) {
      if (current.parentId === possibleAncestorId) return true;
      seen.add(current.id); current = folders.find((f) => f.id === current!.parentId);
    }
    return false;
  };

  const canDropInside = (item: SidebarDragItem, targetFolderId: string) => {
    if (item.type === 'chat') return true;
    return item.id !== targetFolderId && !isFolderDescendantOf(targetFolderId, item.id);
  };

  const renderLevel = (parentId: string | null, depth: number): React.ReactNode => {
    const siblings = childrenOf(parentId);
    return siblings.map((item, index) => {
      if (item.type === 'chat') {
        const chat = chats.find((c) => c.id === item.id)!;
        return <ChatItem key={`chat:${chat.id}`} chat={chat} depth={depth} isActive={activeChat?.id === chat.id} terminalStatus={terminalChatStatuses[chat.id]} dragItem={dragItem} setDragItem={setDragItem} onSelect={() => onSelectChat(chat.id)} onDelete={() => onDeleteChat(chat.id)} onRename={(title) => onRenameChat(chat.id, title)} onDropAt={(dragged, position) => onMoveItem(dragged, parentId, index + (position === 'after' ? 1 : 0))} />;
      }
      const folder = folders.find((f) => f.id === item.id)!;
      const expanded = folder.collapsed !== true;
      return <FolderItem key={`folder:${folder.id}`} folder={folder} depth={depth} expanded={expanded} latestTimestamp={folderTimestamp(folder)} dragItem={dragItem} setDragItem={setDragItem} canDropInside={canDropInside} onToggle={() => onSetFolderCollapsed(folder.id, expanded)} onRename={(name) => onRenameFolder(folder.id, name)} onDelete={() => onDeleteFolder(folder.id)} onDropAt={(dragged, position) => {
        if (position === 'inside') {
          if (canDropInside(dragged, folder.id)) {
            onMoveItem(dragged, folder.id, childrenOf(folder.id).length, expanded ? undefined : folder.id);
          }
        } else onMoveItem(dragged, parentId, index + (position === 'after' ? 1 : 0));
      }}>{renderLevel(folder.id, depth + 1)}</FolderItem>;
    });
  };

  return (
    <div className={`h-full min-h-0 flex flex-col bg-ash-900 ${embedded ? '' : 'border-r border-ash-800'}`}>
      <div className={`${compact ? 'p-2' : 'p-3'} border-b border-ash-800 flex gap-2`}>
        <button type="button" onClick={onNewChat} className={`flex-1 flex items-center justify-center gap-2 bg-ash-800 hover:bg-ash-700 text-ash-200 rounded-md transition-colors ${compact ? 'px-2 py-1.5' : 'px-4 py-2'}`}><Plus className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} /><span className={`${compact ? 'text-xs' : 'text-sm'} font-medium`}>New Chat</span></button>
        <button type="button" onClick={onNewFolder} className={`flex-1 flex items-center justify-center gap-2 bg-ash-800 hover:bg-ash-700 text-ash-200 rounded-md transition-colors ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}`} title="New folder"><FolderPlus className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} /><span className={`${compact ? 'text-xs' : 'text-sm'} font-medium truncate`}>New Folder</span></button>
      </div>
      <div
        className="flex-1 overflow-y-auto"
        onDragOver={(e) => { if (dragItem) e.preventDefault(); }}
        onDrop={(e) => { if (!dragItem) return; e.preventDefault(); onMoveItem(dragItem, null, childrenOf(null).length); setDragItem(null); }}
      >
        {chats.length === 0 && folders.length === 0 ? <div className={`${compact ? 'p-3 text-xs' : 'p-4 text-sm'} text-center text-ash-500`}>{emptyText}</div> : <div className="p-2 space-y-0.5">{renderLevel(null, 0)}</div>}
      </div>
    </div>
  );
}
