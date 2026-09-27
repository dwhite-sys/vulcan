import { useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Plus, FolderPlus, Folder, MoreHorizontal, Trash2, Edit2, Download, Check, X, ChevronDown, ChevronRight, Search, ArrowUp, ArrowDown } from 'lucide-react';
import type { BranchRecord, Chat, ChatFolder } from '../types/vulcan';
import type { ChatTerminalStatus } from '../services/vulcan';
import { buildFolderRecency, directChatsByRecency, directFoldersByRecency, filterSidebarByQuery } from '../services/sidebarOrdering';
import { clampSearchIndex, type TranscriptSearchMatch } from '../services/transcriptSearch';

export type SidebarDragItem = { type: 'chat' | 'folder'; id: string };

interface KitSidebarProps {
  chats: Chat[];
  folders: ChatFolder[];
  activeChat: Chat | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onNewFolder: () => void;
  onDeleteChat: (chatId: string) => void;
  onDownloadChat: (chatId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onSetFolderCollapsed: (folderId: string, collapsed: boolean) => void;
  onMoveItem: (item: SidebarDragItem, parentFolderId: string | null, expandFolderId?: string) => void;
  compact?: boolean;
  embedded?: boolean;
  emptyText?: string;
  terminalChatStatuses?: Record<string, ChatTerminalStatus>;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searchMatchesByChat: ReadonlyMap<string, TranscriptSearchMatch[]>;
  searchHitIndexByChat: Readonly<Record<string, number>>;
  onNavigateSearchHit: (chatId: string, delta: number) => void;
  onSelectSearchHit: (chatId: string, hitIndex: number) => void;
  onSearchInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  branchMode?: boolean;
  branches?: BranchRecord[];
  selectedBranchId?: string | null;
  branchSearchMatches?: ReadonlyMap<string, TranscriptSearchMatch[]>;
  branchSearchHitIndex?: Readonly<Record<string, number>>;
  onSelectBranch?: (branchId: string) => void;
  onRenameBranch?: (branchId: string, title: string) => void;
  onNavigateBranchSearchHit?: (branchId: string, delta: number) => void;
  onSelectBranchSearchHit?: (branchId: string, hitIndex: number) => void;
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

function ContextMenu({ onDownload, onRename, onDelete, onClose }: { onDownload?: () => void; onRename: () => void; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 w-40 bg-ash-900 border border-ash-700 rounded-lg shadow-xl z-40 overflow-hidden py-1">
      {onDownload && <button onClick={(e) => { e.stopPropagation(); onDownload(); onClose(); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ash-300 hover:bg-ash-800 transition-colors"><Download className="w-3.5 h-3.5" />Download JSON</button>}
      <button onClick={(e) => { e.stopPropagation(); onRename(); onClose(); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ash-300 hover:bg-ash-800 transition-colors"><Edit2 className="w-3.5 h-3.5" />Rename</button>
      <button onClick={(e) => { e.stopPropagation(); onDelete(); onClose(); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-ash-800 transition-colors"><Trash2 className="w-3.5 h-3.5" />Delete</button>
    </div>
  );
}

type DropHint = 'inside' | null;

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
      style={{ paddingLeft: `${8 + depth * 20}px`, paddingRight: '8px' }}
    >
      {children}
    </div>
  );
}

function searchHitRole(eventType: string): string {
  switch (eventType) {
    case 'user_message': return 'USER';
    case 'assistant_text': return 'ASSISTANT';
    case 'reasoning': return 'REASONING';
    case 'tool': return 'TOOL';
    case 'system_message': return 'SYSTEM';
    case 'presented_file': return 'FILE';
    case 'panel': return 'DASHBOARD';
    default: return 'MESSAGE';
  }
}

function SearchHitViewer({
  matches, query, activeIndex, onSelect,
}: {
  matches: TranscriptSearchMatch[];
  query: string;
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  const viewerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewer = viewerRef.current;
    const item = viewer?.querySelector<HTMLElement>(`[data-search-hit-index="${activeIndex}"]`);
    if (!viewer || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < viewer.scrollTop) viewer.scrollTo({ top, behavior: 'smooth' });
    else if (bottom > viewer.scrollTop + viewer.clientHeight) {
      viewer.scrollTo({ top: bottom - viewer.clientHeight, behavior: 'smooth' });
    }
  }, [activeIndex]);

  const needle = query.trim().toLocaleLowerCase();
  return (
    <div
      ref={viewerRef}
      className="h-[174px] overflow-y-auto border-l border-t border-ash-700/70 bg-ash-950/35 [scrollbar-width:thin]"
    >
      {matches.map((match, index) => {
        // The server already returned the matched message. Build the two-line
        // excerpt from that one string only; never touch the conversation's
        // full event array merely to populate sidebar search results.
        const message = match.preview ?? '';
        const haystack = message.toLocaleLowerCase();
        const at = needle ? haystack.indexOf(needle) : -1;
        const radius = 72;
        let prefix = '';
        let found = '';
        let suffix = '';
        if (at >= 0) {
          const from = Math.max(0, at - radius);
          const to = Math.min(message.length, at + needle.length + radius);
          prefix = `${from > 0 ? '…' : ''}${message.slice(from, at)}`;
          found = message.slice(at, at + needle.length);
          suffix = `${message.slice(at + needle.length, to)}${to < message.length ? '…' : ''}`;
        } else {
          prefix = message.length > 150 ? `${message.slice(0, 150)}…` : message;
        }
        const timestamp = new Date(match.timestamp || '');
        return (
          <button
            key={match.id}
            type="button"
            data-search-hit-index={index}
            onClick={(click) => { click.stopPropagation(); onSelect(index); }}
            className={`block min-h-[58px] w-full border-b border-ash-800 px-2.5 py-2 text-left transition-colors last:border-b-0 ${index === activeIndex ? 'bg-amber-300/[0.06] shadow-[inset_2px_0_0_rgba(215,182,77,.9)]' : 'hover:bg-ash-800/60'}`}
          >
            <div className="mb-1 flex items-center gap-2 text-[9px] tracking-wide text-ash-500">
              <span>{searchHitRole(match.eventType)}</span>
              <span className="ml-auto tracking-normal text-ash-600">{Number.isNaN(timestamp.getTime()) ? '' : timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
            <div className="line-clamp-2 text-[11px] leading-[1.35] text-ash-300">
              {prefix}{found ? <mark className={`${index === activeIndex ? 'ring-1 ring-amber-200/70' : ''} rounded-sm bg-amber-300/75 px-px text-ash-950`}>{found}</mark> : null}{suffix}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function queryWords(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function searchTextMatchesWords(text: string | null | undefined, words: string[]): boolean {
  if (words.length === 0) return false;
  const haystack = (text ?? '').toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

function matchedAutoTags(tags: string[] | undefined, words: string[]): string[] {
  if (!tags?.length || words.length === 0) return [];
  const normalized = tags.map((tag) => ({ tag, text: tag.toLocaleLowerCase() }));
  const corpus = normalized.map(({ text }) => text).join(' ');
  if (!words.every((word) => corpus.includes(word))) return [];
  // Return the tags that actually contributed at least one search token. This keeps
  // the provenance popover explanatory instead of dumping every topic on the chat.
  return normalized.filter(({ text }) => words.some((word) => text.includes(word))).map(({ tag }) => tag);
}

function AutoTagMatch({ tags }: { tags: string[] }) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, arrowX: 0, below: false });

  const positionTooltip = () => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;
    const rect = trigger.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const margin = 10;
    const gap = 7;
    const idealLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(margin, Math.min(idealLeft, window.innerWidth - width - margin));
    let top = rect.top - height - gap;
    let below = false;
    if (top < margin) {
      top = rect.bottom + gap;
      below = true;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    const arrowX = Math.max(10, Math.min(rect.left + rect.width / 2 - left, width - 10));
    setPosition({ left, top, arrowX, below });
  };

  useLayoutEffect(() => {
    if (!visible) return;
    positionTooltip();
    const refresh = () => positionTooltip();
    window.addEventListener('resize', refresh);
    window.addEventListener('scroll', refresh, true);
    return () => {
      window.removeEventListener('resize', refresh);
      window.removeEventListener('scroll', refresh, true);
    };
  }, [visible, tags]);

  const multiDeck = tags.length >= 5;
  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        className="inline-block cursor-default font-semibold text-coral-400 outline-none"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
      >
        {tags.length === 1 ? 'auto-tag' : 'auto-tags'}
      </span>
      {visible && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          className="pointer-events-none fixed z-[9999] max-w-[calc(100vw-20px)] rounded-md border border-ash-600 bg-ash-950 px-2 py-1.5 text-[9px] leading-[1.35] text-ash-400 shadow-2xl"
          style={{ left: position.left, top: position.top }}
        >
          <div
            className={`${multiDeck ? 'flex max-w-[300px] flex-wrap justify-center gap-x-1 gap-y-0.5 whitespace-normal' : 'flex items-center gap-0.5 whitespace-nowrap'}`}
          >
            {tags.map((tag) => (
              <span key={tag} className="rounded border border-ash-600 bg-ash-800 px-1.5 py-px text-ash-400">{tag}</span>
            ))}
          </div>
          <span
            aria-hidden="true"
            className={`absolute h-0 w-0 -translate-x-1/2 border-[5px] border-transparent ${position.below ? 'bottom-full border-b-ash-600' : 'top-full border-t-ash-600'}`}
            style={{ left: position.arrowX }}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

function ChatItem({
  chat, depth, isActive, terminalStatus, dragItem, setDragItem, onSelect, onDelete, onDownload, onRename,
  searchQuery, searchMatches = [], searchHitIndex = 0, isPinnedCurrent = false, onNavigateSearchHit, onSelectSearchHit,
}: {
  chat: Chat; depth: number; isActive: boolean; terminalStatus?: ChatTerminalStatus;
  dragItem: SidebarDragItem | null; setDragItem: (v: SidebarDragItem | null) => void;
  onSelect: () => void; onDelete: () => void; onDownload: () => void; onRename: (title: string) => void;
  searchQuery?: string; searchMatches?: TranscriptSearchMatch[]; searchHitIndex?: number; isPinnedCurrent?: boolean;
  onNavigateSearchHit?: (delta: number) => void; onSelectSearchHit?: (index: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(chat.title ?? '');
  const [displayTitle, setDisplayTitle] = useState(chat.title ?? '');
  const [titleStreaming, setTitleStreaming] = useState(!chat.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousTitleRef = useRef(chat.title ?? '');
  useEffect(() => { if (!editing) setEditValue(chat.title ?? ''); }, [chat.title, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  useEffect(() => {
    const next = chat.title ?? '';
    const previous = previousTitleRef.current;
    previousTitleRef.current = next;
    if (!next) {
      setDisplayTitle('');
      setTitleStreaming(true);
      return;
    }
    if (previous) {
      setDisplayTitle(next);
      setTitleStreaming(false);
      return;
    }
    let visible = 0;
    setDisplayTitle('');
    setTitleStreaming(true);
    const increment = Math.max(1, Math.ceil(next.length / 18));
    const timer = window.setInterval(() => {
      visible = Math.min(next.length, visible + increment);
      setDisplayTitle(next.slice(0, visible));
      if (visible === next.length) {
        window.clearInterval(timer);
        setTitleStreaming(false);
      }
    }, 32);
    return () => window.clearInterval(timer);
  }, [chat.id, chat.title]);
  const commitRename = () => { const trimmed = editValue.trim(); if (trimmed && trimmed !== chat.title) onRename(trimmed); setEditing(false); };
  const cancelRename = () => { setEditValue(chat.title ?? ''); setEditing(false); };
  const hasSearchHits = Boolean(searchQuery?.trim()) && searchMatches.length > 0;
  const clampedSearchHitIndex = hasSearchHits ? clampSearchIndex(searchHitIndex, searchMatches.length) : 0;
  const words = queryWords(searchQuery ?? '');
  const titleMatched = searchTextMatchesWords(chat.title, words);
  const autoTagsMatched = matchedAutoTags(chat.tags, words);
  const hasSearchProvenance = words.length > 0 && (titleMatched || hasSearchHits || autoTagsMatched.length > 0);
  return (
    <div className="group/search-result">
      {showDeleteModal && <DeleteModal title={chat.title || 'this chat'} onConfirm={() => { setShowDeleteModal(false); onDelete(); }} onCancel={() => setShowDeleteModal(false)} />}
      <RowShell
        depth={depth} active={isActive} dropHint={null} draggable={!editing}
        onClick={() => { if (!editing) onSelect(); }}
        onDragStart={(e) => { const item: SidebarDragItem = { type: 'chat', id: chat.id }; setDragItem(item); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', JSON.stringify(item)); }}
        onDragEnd={() => setDragItem(null)}
        onDragOver={(e) => { if (dragItem) { e.stopPropagation(); e.dataTransfer.dropEffect = 'none'; } }}
        onDrop={(e) => { if (dragItem) e.stopPropagation(); }}
      >
        <div className="flex items-center gap-2 min-w-0 min-h-[48px]">
          <div className="flex-1 min-w-0">
            {editing ? (
              <input ref={inputRef} value={editValue} onChange={(e) => setEditValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename(); }} onClick={(e) => e.stopPropagation()} className="w-full text-sm font-medium bg-ash-700 text-ash-100 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-coral-500" />
            ) : <h3 className={`text-sm overflow-hidden whitespace-nowrap text-ellipsis max-w-full min-h-[20px] ${titleStreaming ? 'shimmer' : ''}`} aria-busy={titleStreaming} title={chat.tags?.length ? `Topics: ${chat.tags.join(', ')}` : undefined}>{displayTitle}</h3>}
            {!editing && (
              <p className={`mt-0.5 text-[8px] leading-[1.25] text-ash-500 ${hasSearchProvenance ? 'w-[calc(100%+62px)] overflow-hidden whitespace-nowrap' : ''}`}>
                {relativeTime(new Date(chat.updatedAt))}
                {hasSearchProvenance && (
                  <>
                    <span> · matches: </span>
                    {titleMatched && <span className="font-semibold text-coral-400">title</span>}
                    {titleMatched && (hasSearchHits || autoTagsMatched.length > 0) && <span> · </span>}
                    {hasSearchHits && <span className="font-semibold text-coral-400">{searchMatches.length === 1 ? 'message' : 'messages'}</span>}
                    {hasSearchHits && <span> ({searchMatches.length})</span>}
                    {hasSearchHits && autoTagsMatched.length > 0 && <span> · </span>}
                    {autoTagsMatched.length > 0 && <AutoTagMatch tags={autoTagsMatched} />}
                    {autoTagsMatched.length > 0 && <span> ({autoTagsMatched.length})</span>}
                  </>
                )}
              </p>
            )}
          </div>
          {!editing && !Boolean(searchQuery?.trim()) && terminalStatus && (terminalStatus.userOpen || terminalStatus.agentOpen) && (
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
          {!editing && Boolean(searchQuery?.trim()) && isPinnedCurrent && (
            <div className="ml-auto flex shrink-0 items-start">
              <span className="rounded-full border border-green-700/70 bg-green-900/35 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-green-300">CURRENT</span>
            </div>
          )}
          {editing ? (
            <div className="flex items-center gap-1 flex-shrink-0">
              <button type="button" onClick={(e) => { e.stopPropagation(); commitRename(); }} className="p-1 hover:bg-ash-700 rounded" title="Save"><Check className="w-3 h-3 text-green-400" /></button>
              <button type="button" onClick={(e) => { e.stopPropagation(); cancelRename(); }} className="p-1 hover:bg-ash-700 rounded" title="Cancel"><X className="w-3 h-3 text-ash-400" /></button>
            </div>
          ) : (
            <div className="relative flex flex-shrink-0 flex-col items-end gap-0.5">
              <button type="button" onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }} className={`p-1 rounded transition-all hover:bg-ash-700 ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} title="More options"><MoreHorizontal className="w-4 h-4 text-ash-400" /></button>
              {hasSearchHits && (
                <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover/search-result:opacity-100 group-focus-within/search-result:opacity-100">
                  <button type="button" onClick={(event) => { event.stopPropagation(); onNavigateSearchHit?.(-1); }} className="grid h-5 w-5 place-items-center rounded text-ash-500 hover:bg-ash-700 hover:text-ash-200" title="Previous match" aria-label="Previous match"><ArrowUp className="h-3 w-3" /></button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); onNavigateSearchHit?.(1); }} className="grid h-5 w-5 place-items-center rounded text-ash-500 hover:bg-ash-700 hover:text-ash-200" title="Next match" aria-label="Next match"><ArrowDown className="h-3 w-3" /></button>
                </div>
              )}
              {menuOpen && <ContextMenu onDownload={onDownload} onRename={() => setEditing(true)} onDelete={() => setShowDeleteModal(true)} onClose={() => setMenuOpen(false)} />}
            </div>
          )}
        </div>
      </RowShell>
      {hasSearchHits && onSelectSearchHit && (
        <div style={{ marginLeft: `${8 + (depth + 1) * 20}px`, marginRight: '8px' }}>
          <SearchHitViewer matches={searchMatches} query={searchQuery ?? ''} activeIndex={clampedSearchHitIndex} onSelect={onSelectSearchHit} />
        </div>
      )}
    </div>
  );
}


function BranchItem({
  branch, selected, searchQuery, matches, hitIndex, onSelect, onRename, onNavigateHit, onSelectHit,
}: {
  branch: BranchRecord; selected: boolean; searchQuery: string; matches: TranscriptSearchMatch[]; hitIndex: number;
  onSelect: () => void; onRename: (title: string) => void; onNavigateHit: (delta: number) => void; onSelectHit: (index: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(branch.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!editing) setDraft(branch.title); }, [branch.title, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  const commit = () => { const title = draft.trim(); if (title && title !== branch.title) onRename(title); setEditing(false); };
  const hasHits = Boolean(searchQuery.trim()) && matches.length > 0;
  const activeIndex = hasHits ? clampSearchIndex(hitIndex, matches.length) : 0;
  const branchSearchWords = queryWords(searchQuery);
  const branchTitleMatched = searchTextMatchesWords(branch.title, branchSearchWords);
  const branchHasSearchProvenance = branchSearchWords.length > 0 && (branchTitleMatched || hasHits);
  return (
    <div className="group/search-result">
      <RowShell depth={0} active={selected} dropHint={null} onClick={() => { if (!editing) onSelect(); }}>
        <div className="flex min-h-[48px] min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            {editing ? (
              <input ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={commit}
                onKeyDown={(event) => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') { setDraft(branch.title); setEditing(false); } }}
                className="w-full rounded bg-ash-700 px-1 py-0.5 text-sm font-medium text-ash-100 outline-none ring-1 ring-coral-700 focus:ring-coral-500" />
            ) : <h3 className="min-h-[20px] max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm">{branch.title}</h3>}
            {!editing && (
              <p className={`mt-0.5 text-[8px] leading-[1.25] text-ash-500 ${branchHasSearchProvenance ? 'w-[calc(100%+62px)] overflow-hidden whitespace-nowrap' : ''}`}>
                <span className="font-semibold tracking-wide text-coral-400">{branch.origin.toUpperCase()}</span>
                <span> · {new Date(branch.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                {branchHasSearchProvenance && (
                  <>
                    <span> · matches: </span>
                    {branchTitleMatched && <span className="font-semibold text-coral-400">title</span>}
                    {branchTitleMatched && hasHits && <span> · </span>}
                    {hasHits && <span className="font-semibold text-coral-400">{matches.length === 1 ? 'message' : 'messages'}</span>}
                    {hasHits && <span> ({matches.length})</span>}
                  </>
                )}
              </p>
            )}
          </div>
          {!editing && (
            <div className="ml-auto flex shrink-0 flex-col items-end gap-0.5">
              <button type="button" onClick={(event) => { event.stopPropagation(); setEditing(true); }} title="Rename branch" aria-label={`Rename ${branch.title}`}
                className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded text-ash-500 opacity-70 transition-all hover:bg-ash-700 hover:text-ash-200 hover:opacity-100">
                <Edit2 className="h-3 w-3" />
              </button>
              {hasHits && (
                <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover/search-result:opacity-100 group-focus-within/search-result:opacity-100">
                  <button type="button" onClick={(event) => { event.stopPropagation(); onNavigateHit(-1); }} className="grid h-5 w-5 place-items-center rounded text-ash-500 hover:bg-ash-700 hover:text-ash-200" aria-label="Previous branch match"><ArrowUp className="h-3 w-3" /></button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); onNavigateHit(1); }} className="grid h-5 w-5 place-items-center rounded text-ash-500 hover:bg-ash-700 hover:text-ash-200" aria-label="Next branch match"><ArrowDown className="h-3 w-3" /></button>
                </div>
              )}
            </div>
          )}
        </div>
      </RowShell>
      {hasHits && (
        <div className="ml-7 mr-2">
          <SearchHitViewer matches={matches} query={searchQuery} activeIndex={activeIndex} onSelect={onSelectHit} />
        </div>
      )}
    </div>
  );
}

function FolderItem({
  folder, depth, expanded, latestTimestamp, dragItem, setDragItem, canDropInside,
  onToggle, onRename, onDelete, onDropInside, children,
}: {
  folder: ChatFolder; depth: number; expanded: boolean; latestTimestamp: Date;
  dragItem: SidebarDragItem | null; setDragItem: (v: SidebarDragItem | null) => void; canDropInside: (item: SidebarDragItem, folderId: string) => boolean;
  onToggle: () => void; onRename: (name: string) => void; onDelete: () => void;
  onDropInside: (item: SidebarDragItem) => void; children: React.ReactNode;
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
          setDropHint(canDropInside(dragItem, folder.id) ? 'inside' : null);
        }}
        onDragLeave={() => setDropHint(null)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (dragItem && dropHint === 'inside') onDropInside(dragItem); setDropHint(null); setDragItem(null); }}
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
  chats, folders, activeChat, onSelectChat, onNewChat, onNewFolder, onDeleteChat, onDownloadChat, onRenameChat,
  onRenameFolder, onDeleteFolder, onSetFolderCollapsed, onMoveItem, compact = false, embedded = false, emptyText = 'No chats yet',
  terminalChatStatuses = {}, searchQuery, onSearchQueryChange, searchInputRef, searchMatchesByChat, searchHitIndexByChat,
  onNavigateSearchHit, onSelectSearchHit, onSearchInputKeyDown,
  branchMode = false, branches = [], selectedBranchId = null, branchSearchMatches = new Map(), branchSearchHitIndex = {},
  onSelectBranch, onRenameBranch, onNavigateBranchSearchHit, onSelectBranchSearchHit,
}: KitSidebarProps) {
  const [dragItem, setDragItem] = useState<SidebarDragItem | null>(null);
  const query = searchQuery;
  const contentMatchedChatIds = useMemo(() => new Set(
    [...searchMatchesByChat.entries()].filter(([, matches]) => matches.length > 0).map(([chatId]) => chatId),
  ), [searchMatchesByChat]);
  const allVisible = useMemo(() => filterSidebarByQuery(chats, folders, query, contentMatchedChatIds), [chats, folders, query, contentMatchedChatIds]);
  const pinnedActiveChat = query.trim() && activeChat && allVisible.chats.some((chat) => chat.id === activeChat.id) ? activeChat : null;
  const visible = useMemo(() => pinnedActiveChat
    ? filterSidebarByQuery(chats.filter((chat) => chat.id !== pinnedActiveChat.id), folders, query, new Set([...contentMatchedChatIds].filter((id) => id !== pinnedActiveChat.id)))
    : allVisible, [allVisible, chats, folders, query, contentMatchedChatIds, pinnedActiveChat]);

  // Chats are MRU within their parent. Folders are MRU by their newest chat
  // descendant, recursively. Direct chats are rendered before direct folders.
  const folderRecency = useMemo(() => buildFolderRecency(visible.chats, visible.folders), [visible]);

  const chatsOf = (parentId: string | null) => directChatsByRecency(visible.chats, parentId);
  const foldersOf = (parentId: string | null) => directFoldersByRecency(visible.folders, parentId, folderRecency);

  const folderTimestamp = (folder: ChatFolder): Date =>
    folderRecency.get(folder.id) ?? new Date(folder.createdAt);

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
    const directChats = chatsOf(parentId);
    const directFolders = foldersOf(parentId);

    return (
      <>
        {directChats.map((chat) => (
          <ChatItem
            key={`chat:${chat.id}`}
            chat={chat}
            depth={depth}
            isActive={activeChat?.id === chat.id}
            terminalStatus={terminalChatStatuses[chat.id]}
            dragItem={dragItem}
            setDragItem={setDragItem}
            onSelect={() => onSelectChat(chat.id)}
            onDelete={() => onDeleteChat(chat.id)}
            onDownload={() => onDownloadChat(chat.id)}
            onRename={(title) => onRenameChat(chat.id, title)}
            searchQuery={query}
            searchMatches={searchMatchesByChat.get(chat.id) ?? []}
            searchHitIndex={searchHitIndexByChat[chat.id] ?? 0}
            onNavigateSearchHit={(delta) => onNavigateSearchHit(chat.id, delta)}
            onSelectSearchHit={(index) => onSelectSearchHit(chat.id, index)}
          />
        ))}
        {directFolders.map((folder) => {
          const expanded = Boolean(query.trim()) || folder.collapsed !== true;
          return (
            <FolderItem
              key={`folder:${folder.id}`}
              folder={folder}
              depth={depth}
              expanded={expanded}
              latestTimestamp={folderTimestamp(folder)}
              dragItem={dragItem}
              setDragItem={setDragItem}
              canDropInside={canDropInside}
              onToggle={() => onSetFolderCollapsed(folder.id, expanded)}
              onRename={(name) => onRenameFolder(folder.id, name)}
              onDelete={() => onDeleteFolder(folder.id)}
              onDropInside={(dragged) => {
                if (canDropInside(dragged, folder.id)) {
                  onMoveItem(dragged, folder.id, expanded ? undefined : folder.id);
                }
              }}
            >
              {renderLevel(folder.id, depth + 1)}
            </FolderItem>
          );
        })}
      </>
    );
  };


  const visibleBranches = branchMode ? [...branches]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((branch) => {
      if (!query.trim()) return true;
      const titleMatch = branch.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
      return titleMatch || (branchSearchMatches.get(branch.id)?.length ?? 0) > 0;
    }) : [];

  return (
    <div className={`h-full min-h-0 flex flex-col bg-ash-900 ${embedded ? '' : 'border-r border-ash-800'}`}>
      <div className={`${compact ? 'p-2' : 'p-3'} border-b border-ash-800 flex gap-2`}>
        <button type="button" onClick={onNewChat} className={`flex-1 flex items-center justify-center gap-2 bg-ash-800 hover:bg-ash-700 text-ash-200 rounded-md transition-colors ${compact ? 'px-2 py-1.5' : 'px-4 py-2'}`}><Plus className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} /><span className={`${compact ? 'text-xs' : 'text-sm'} font-medium`}>New Chat</span></button>
        <button type="button" onClick={onNewFolder} className={`flex-1 flex items-center justify-center gap-2 bg-ash-800 hover:bg-ash-700 text-ash-200 rounded-md transition-colors ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}`} title="New folder"><FolderPlus className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} /><span className={`${compact ? 'text-xs' : 'text-sm'} font-medium truncate`}>New Folder</span></button>
      </div>
      <div className={`${compact ? 'px-2 py-1.5' : 'px-3 py-2'} border-b border-ash-800`}>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ash-500" />
          <input
            type="text"
            ref={searchInputRef}
            value={query}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={onSearchInputKeyDown}
            placeholder={branchMode ? "Search branches" : "Search chats, tags, and messages"}
            aria-label={branchMode ? "Search branches and branch messages" : "Search chats, topic tags, folders, and messages"}
            className="w-full rounded-md border border-transparent bg-ash-800/70 py-1.5 pl-8 pr-7 text-xs text-ash-200 placeholder:text-ash-500 outline-none transition-colors focus:border-ash-600"
          />
          {query && (
            <button
              type="button"
              onClick={() => onSearchQueryChange('')}
              aria-label={branchMode ? "Clear branch search" : "Clear chat search"}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ash-400 hover:text-ash-200"
            ><X className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </div>
      <div
        className="flex-1 overflow-y-auto"
        onDragOver={(e) => { if (dragItem) e.preventDefault(); }}
        onDrop={(e) => { if (!dragItem) return; e.preventDefault(); onMoveItem(dragItem, null); setDragItem(null); }}
      >
        {branchMode ? (
          <div className="p-2 space-y-0.5">
            {visibleBranches.map((branch) => (
                <BranchItem key={branch.id} branch={branch} selected={branch.id === selectedBranchId}
                  searchQuery={query} matches={branchSearchMatches.get(branch.id) ?? []} hitIndex={branchSearchHitIndex[branch.id] ?? 0}
                  onSelect={() => onSelectBranch?.(branch.id)} onRename={(title) => onRenameBranch?.(branch.id, title)}
                  onNavigateHit={(delta) => onNavigateBranchSearchHit?.(branch.id, delta)} onSelectHit={(index) => onSelectBranchSearchHit?.(branch.id, index)} />
              ))}
            {visibleBranches.length === 0 && <div className={`${compact ? 'p-3 text-xs' : 'p-4 text-sm'} text-center text-ash-500`}>{query.trim() ? 'No matching branches' : 'No branches yet'}</div>}
          </div>
        ) : visible.chats.length === 0 && visible.folders.length === 0 && !pinnedActiveChat ? <div className={`${compact ? 'p-3 text-xs' : 'p-4 text-sm'} text-center text-ash-500`}>{query.trim() ? 'No matching chats' : emptyText}</div> : <div className="p-2 space-y-0.5">
          {pinnedActiveChat && (
            <ChatItem
              key={`pinned:${pinnedActiveChat.id}`} chat={pinnedActiveChat} depth={0} isActive terminalStatus={terminalChatStatuses[pinnedActiveChat.id]}
              dragItem={dragItem} setDragItem={setDragItem} onSelect={() => onSelectChat(pinnedActiveChat.id)}
              onDelete={() => onDeleteChat(pinnedActiveChat.id)} onDownload={() => onDownloadChat(pinnedActiveChat.id)} onRename={(title) => onRenameChat(pinnedActiveChat.id, title)}
              searchQuery={query} searchMatches={searchMatchesByChat.get(pinnedActiveChat.id) ?? []} searchHitIndex={searchHitIndexByChat[pinnedActiveChat.id] ?? 0}
              isPinnedCurrent onNavigateSearchHit={(delta) => onNavigateSearchHit(pinnedActiveChat.id, delta)} onSelectSearchHit={(index) => onSelectSearchHit(pinnedActiveChat.id, index)}
            />
          )}
          {renderLevel(null, 0)}
        </div>}
      </div>
    </div>
  );
}
