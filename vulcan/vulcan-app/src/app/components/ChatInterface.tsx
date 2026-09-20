import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { toast } from 'sonner';
import * as vulcan from '../services/vulcan';
import { ChevronLeft, ChevronRight, ChevronDown, Pencil, Quote, Copy, X } from 'lucide-react';
import { TranscriptRenderer } from './TranscriptRenderer';
import { type QuoteComposerHandle } from './QuoteComposer';
import { MessageComposer } from './MessageComposer';
import { ContextConnections } from './ContextConnections';
import { KitToggleMenu } from './KitToggleMenu';
import { SkillToggleMenu } from './SkillToggleMenu';
import type { SkillMeta } from './SkillToggleMenu';
import type { ChatEvent, ComposerContextItem, Kit, Message, MessageAttachment, MessageEditPayload, MessageElementReference, MessageFileReference, MessageQuote, UserQuestionBatch, UserQuestionAnswer } from '../types/vulcan';
import { stripQuoteReferenceTokens } from '../services/quoteProjection';
import { TranscriptScrollController, type TranscriptScrollSnapshot } from '../services/transcriptScroll';
import { messageContextItems, splitComposerContext } from '../services/messageEditing';
import type { TranscriptSearchMatch } from '../services/transcriptSearch';

const transcriptScrollPositions = new Map<string, TranscriptScrollSnapshot>();

interface EditDraft {
  messageId: string;
  input: string;
  contextItems: ComposerContextItem[];
  files: File[];
  existingAttachments: MessageAttachment[];
}

interface ChatInterfaceProps {
  chatId?: string;
  /** Stable identity for this transcript projection. Branch previews must use a branch-specific value. */
  transcriptViewId?: string;
  events: ChatEvent[];
  kits: Kit[];
  onSendMessage: (content: string, attachments?: File[], quotes?: MessageQuote[], references?: MessageFileReference[], contextOrder?: string[], elements?: MessageElementReference[]) => void;
  onToggleKit: (kitName: string, enabled: boolean) => void;
  skills: SkillMeta[];
  onToggleSkill: (stem: string, enabled: boolean) => void;
  onStop: () => void;
  onEditMessage: (messageId: string, payload: MessageEditPayload) => void;
  onRetry: (userMessageId: string) => void;
  isProcessing?: boolean;
  uploadsEnabled?: boolean;
  questionBatch?: UserQuestionBatch | null;
  onResolveQuestionBatch?: (answers: Record<string, UserQuestionAnswer>) => void;
  searchQuery?: string;
  activeSearchMatch?: TranscriptSearchMatch;
}

function QuestionToolPanel({
  batch,
  onResolve,
}: {
  batch: UserQuestionBatch;
  onResolve: (answers: Record<string, UserQuestionAnswer>) => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, UserQuestionAnswer>>({});
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  useEffect(() => {
    setIndex(0);
    setAnswers({});
    setCustomValues({});
  }, [batch.id]);

  const question = batch.questions[index];
  if (!question) return null;

  const completeWith = (answer: UserQuestionAnswer) => {
    const next = { ...answers, [question.toolCallId]: answer };
    setAnswers(next);
    if (Object.keys(next).length >= batch.questions.length) {
      onResolve(next);
      return;
    }
    const nextUnanswered = batch.questions.findIndex((q, i) => i > index && !next[q.toolCallId]);
    if (nextUnanswered >= 0) setIndex(nextUnanswered);
    else {
      const anyUnanswered = batch.questions.findIndex((q) => !next[q.toolCallId]);
      if (anyUnanswered >= 0) setIndex(anyUnanswered);
    }
  };

  const selected = answers[question.toolCallId];
  const customValue = customValues[question.toolCallId] ?? (selected?.source === 'custom' ? selected.answer ?? '' : '');

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-ash-700 bg-ash-800/95 shadow-lg">
      <div className="flex items-start justify-between gap-4 px-3.5 pt-3 pb-2">
        <div className="min-w-0 text-[13px] leading-5 font-medium text-ash-100">
          {question.question}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-ash-500">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="rounded p-0.5 hover:bg-ash-700 hover:text-ash-200 disabled:opacity-25"
            title="Previous question"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[42px] text-center">{index + 1} of {batch.questions.length}</span>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(batch.questions.length - 1, i + 1))}
            disabled={index === batch.questions.length - 1}
            className="rounded p-0.5 hover:bg-ash-700 hover:text-ash-200 disabled:opacity-25"
            title="Next question"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              const skipped = Object.fromEntries(batch.questions.map((q) => [q.toolCallId, answers[q.toolCallId] ?? { status: 'skipped' }]));
              onResolve(skipped);
            }}
            className="ml-1 rounded p-0.5 hover:bg-ash-700 hover:text-ash-200"
            title="Skip remaining questions"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="px-2 pb-1.5">
        {question.options.slice(0, 5).map((option, optionIndex) => {
          const isSelected = selected?.source === 'option' && selected.option_index === optionIndex;
          return (
            <button
              key={optionIndex}
              type="button"
              onClick={() => completeWith({ status: 'answered', answer: option, source: 'option', option_index: optionIndex })}
              className={`grid w-full grid-cols-[28px_minmax(0,1fr)_18px] items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${isSelected ? 'bg-ash-700' : 'hover:bg-ash-700/70'}`}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ash-700 text-[11px] text-ash-200">
                {optionIndex + 1}
              </span>
              <span className="min-w-0 pt-0.5 text-[12px] leading-[1.45] text-ash-300 whitespace-normal break-words">
                {option}
              </span>
              <span className="pt-0.5 text-sm text-ash-500">{isSelected ? '→' : ''}</span>
            </button>
          );
        })}

        <div className="mt-1 grid grid-cols-[28px_minmax(0,1fr)] items-center gap-2.5 border-t border-ash-700/70 px-2 pt-2 pb-1">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ash-700 text-ash-400">
            <Pencil className="h-3 w-3" />
          </span>
          <input
            type="text"
            value={customValue}
            onChange={(e) => {
              const value = e.target.value;
              setCustomValues((prev) => ({ ...prev, [question.toolCallId]: value }));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const value = customValue.trim();
                if (value) completeWith({ status: 'answered', answer: value, source: 'custom' });
              }
            }}
            placeholder="Something else..."
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[12px] text-ash-200 outline-none placeholder:text-ash-500 focus:border-ash-600 focus:bg-ash-900/50"
          />
        </div>
      </div>

      <div className="flex items-center justify-between px-3.5 pb-2.5 pt-0.5 text-[10px] text-ash-600">
        <span>↑↓ navigate · Enter to select · or type below</span>
        <button
          type="button"
          onClick={() => completeWith({ status: 'skipped' })}
          className="rounded-md border border-ash-700 bg-ash-800 px-2 py-1 text-[11px] text-ash-300 hover:bg-ash-700"
        >
          Skip
        </button>
      </div>
    </div>
  );
}


type VulcanTransfer = {
  id: string;
  filename: string;
  direction: 'download' | 'upload';
  percent: number;
  preparing: boolean;
};

function TransferBar({ transfer }: { transfer: VulcanTransfer }) {
  const width = transfer.preparing ? 100 : transfer.percent;
  return (
    <div className="relative h-2 overflow-hidden rounded-full border border-ash-950 bg-ash-950">
      <div
        className="absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width] duration-200 ease-out bg-coral-600"
        style={{ width: `${width}%` }}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: 'repeating-linear-gradient(125deg, rgba(255,255,255,.28) 0 7px, rgba(255,255,255,.05) 7px 14px)',
            backgroundSize: '28px 28px',
            animation: `vulcan-transfer-barber .7s linear infinite ${transfer.direction === 'upload' ? 'reverse' : 'normal'}`,
          }}
        />
      </div>
    </div>
  );
}

function TransferPrompt({ transfers, onClose, onCancel }: {
  transfers: VulcanTransfer[];
  onClose: () => void;
  onCancel: (id: string) => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[min(620px,calc(100vh-3rem))] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-ash-700 bg-ash-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ash-700 px-4 py-3.5">
          <div className="text-sm font-semibold text-ash-100">
            Active Transfers <span className="ml-1.5 font-normal text-ash-500">{transfers.length}</span>
          </div>
          <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-lg border border-ash-700 bg-ash-900 text-ash-400 transition-colors hover:bg-ash-800 hover:text-ash-100" aria-label="Close active transfers">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="overflow-y-auto p-2">
          {transfers.map((transfer, index) => (
            <div key={transfer.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-lg px-2.5 py-3 hover:bg-ash-800/60 ${index > 0 ? 'border-t border-ash-800' : ''}`}>
              <div className="min-w-0">
                <div className="mb-2 flex items-center gap-2.5">
                  <div className="grid h-5 w-5 shrink-0 place-items-center rounded-md border border-ash-700 text-xs text-ash-400">{transfer.direction === 'download' ? '↓' : '↑'}</div>
                  <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-ash-200">{transfer.direction === 'download' ? 'Downloading' : 'Uploading'}: {transfer.filename}</div>
                  <div className="shrink-0 text-xs tabular-nums text-ash-300">{transfer.preparing ? 'Preparing…' : `${Math.round(transfer.percent)}%`}</div>
                </div>
                <TransferBar transfer={transfer} />
                <div className="mt-1.5 text-[11px] text-ash-500">{transfer.direction === 'download' ? 'Downloading from Vulcan' : 'Uploading to Vulcan'}</div>
              </div>
              <button type="button" onClick={() => onCancel(transfer.id)} className="rounded-lg border border-ash-700 bg-ash-900 px-3.5 py-1.5 text-[11px] text-ash-300 transition-colors hover:border-coral-800 hover:bg-ash-800 hover:text-coral-300">Cancel</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChatInterface({
  chatId,
  transcriptViewId,
  events,
  kits,
  onSendMessage,
  onToggleKit,
  skills,
  onToggleSkill,
  onStop,
  onEditMessage,
  onRetry,
  isProcessing,
  uploadsEnabled = true,
  questionBatch,
  onResolveQuestionBatch,
  searchQuery = '',
  activeSearchMatch,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const [contextItems, setContextItems] = useState<ComposerContextItem[]>([]);
  const quotes = contextItems.filter((item): item is MessageQuote & { kind: 'quote' } => item.kind === 'quote');
  const references = contextItems.filter((item): item is MessageFileReference & { kind: 'reference' } => item.kind === 'reference');
  const elements = contextItems.filter((item): item is MessageElementReference & { kind: 'element' } => item.kind === 'element');
  const contextOrder = contextItems.map((item) => item.id);
  const [quoteMenu, setQuoteMenu] = useState<{ x: number; y: number; quote: MessageQuote } | null>(null);
  const quoteSelectionRangeRef = useRef<Range | null>(null);
  const composerRef = useRef<QuoteComposerHandle | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const scrollControllerRef = useRef<TranscriptScrollController | null>(null);
  const [followingTranscript, setFollowingTranscript] = useState(true);
  const fileDragCounterRef = useRef(0);
  const filesRef = useRef<File[]>([]);
  const uploadPromisesRef = useRef(new Map<File, Promise<boolean>>());
  const uploadedFilesRef = useRef(new Set<File>());
  const uploadTransferIdsRef = useRef(new Map<File, string>());
  const submitInFlightRef = useRef(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const editComposerRef = useRef<QuoteComposerHandle | null>(null);
  const editDraftRef = useRef<EditDraft | null>(null);
  const editFilesRef = useRef<File[]>([]);
  const activeComposerRef = useRef<'main' | 'edit'>('main');
  const [activeComposerTarget, setActiveComposerTargetState] = useState<'main' | 'edit'>('main');
  const setActiveComposerTarget = (target: 'main' | 'edit') => { activeComposerRef.current = target; setActiveComposerTargetState(target); };
  useEffect(() => { editDraftRef.current = editDraft; editFilesRef.current = editDraft?.files ?? []; }, [editDraft]);

  useEffect(() => { filesRef.current = files; }, [files]);

  useEffect(() => {
    // Composer attachments belong to one chat. Switching chats cancels any
    // in-flight attach uploads and clears their local completion state.
    for (const transferId of uploadTransferIdsRef.current.values()) {
      window.dispatchEvent(new CustomEvent('vulcan-transfer-cancel', { detail: { id: transferId } }));
    }
    uploadPromisesRef.current.clear();
    uploadTransferIdsRef.current.clear();
    uploadedFilesRef.current.clear();
    filesRef.current = [];
    setFiles([]);
    setContextItems([]);
    setQuoteMenu(null);
    quoteSelectionRangeRef.current = null;
    setInput('');
    setEditDraft(null);
    editFilesRef.current = [];
    setActiveComposerTarget('main');
  }, [chatId]);

  useEffect(() => {
    if (!quoteMenu) return;
    const close = (event?: Event) => {
      if (event?.target instanceof Element && event.target.closest('.vulcan-quote-context-menu')) return;
      setQuoteMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [quoteMenu]);

  useLayoutEffect(() => {
    if (!quoteMenu) {
      quoteSelectionRangeRef.current = null;
      return;
    }
    const range = quoteSelectionRangeRef.current;
    if (!range || !range.startContainer.isConnected || !range.endContainer.isConnected) {
      quoteSelectionRangeRef.current = null;
      return;
    }
    const selection = window.getSelection();
    if (!selection) return;
    // Opening the custom Quote/Copy menu triggers a React render. Reassert the
    // exact native range before paint so Chromium keeps the ordinary selection
    // highlight visible while the menu is open instead of showing a synthetic
    // second highlight with subtly different selection semantics.
    selection.removeAllRanges();
    selection.addRange(range);
  }, [quoteMenu]);

  const handleQuoteSelection = (event: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const elementFor = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    const start = elementFor(range.startContainer)?.closest<HTMLElement>('[data-vulcan-message-id]');
    const end = elementFor(range.endContainer)?.closest<HTMLElement>('[data-vulcan-message-id]');
    if (!start || start !== end) return;
    const body = start.querySelector<HTMLElement>('[data-vulcan-quote-body]');
    const text = selection.toString();
    if (!body || !text.trim() || !body.contains(range.startContainer) || !body.contains(range.endContainer)) return;
    const before = document.createRange();
    before.selectNodeContents(body);
    before.setEnd(range.startContainer, range.startOffset);
    const prefix = before.cloneContents();
    prefix.querySelectorAll('[data-vulcan-quote-marker-id]').forEach((marker) => marker.remove());
    const offset = prefix.textContent?.length ?? 0;
    const role = start.dataset.vulcanMessageRole;
    if (role !== 'user' && role !== 'assistant') return;
    const quote: MessageQuote = {
      id: `quote-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
      text,
      messageId: start.dataset.vulcanMessageId!,
      sourceRole: role,
      start: offset,
      end: offset + text.length,
    };
    const activeItems = activeComposerRef.current === 'edit' && editDraft ? editDraft.contextItems : contextItems;
    const activeQuotes = activeItems.filter((item): item is MessageQuote & { kind: 'quote' } => item.kind === 'quote');
    const conflict = activeQuotes.some((current) => current.messageId === quote.messageId &&
      current.start < quote.end && quote.start < current.end &&
      !(current.start === quote.start && current.end === quote.end));
    if (conflict) return;
    if (event.type === 'contextmenu') event.preventDefault();
    const bounds = range.getBoundingClientRect();
    const anchorX = 'clientX' in event && event.clientX ? event.clientX : bounds.left;
    const anchorY = 'clientY' in event && event.clientY ? event.clientY : bounds.bottom + 5;
    // Keep a detached copy of the actual browser Range. The menu render can
    // otherwise make Chromium stop painting the native selection even though
    // the quote text/offsets have already been captured correctly.
    quoteSelectionRangeRef.current = range.cloneRange();
    setQuoteMenu({
      x: Math.max(8, Math.min(anchorX, window.innerWidth - 250)),
      y: Math.max(8, Math.min(anchorY, window.innerHeight - 105)),
      quote,
    });
  };

  const insertQuote = (candidate: MessageQuote) => {
    const editing = activeComposerRef.current === 'edit' && editDraft;
    const items = editing ? editDraft.contextItems : contextItems;
    const existing = items.find((item) => item.kind === 'quote' && item.messageId === candidate.messageId &&
      item.start === candidate.start && item.end === candidate.end);
    const quote: ComposerContextItem = existing ?? { ...candidate, kind: 'quote' };
    if (!existing) {
      if (editing) setEditDraft((current) => current ? { ...current, contextItems: [...current.contextItems, quote] } : current);
      else setContextItems((current) => [...current, quote]);
    }
    setQuoteMenu(null);
    window.getSelection()?.removeAllRanges();
    if (editing) editComposerRef.current?.focus();
    else composerRef.current?.focus();
  };

  const removeContextItem = (id: string) => {
    composerRef.current?.removeReferences(id);
    const item = contextItems.find((candidate) => candidate.id === id);
    if (item?.kind === 'reference') {
      window.dispatchEvent(new CustomEvent('vulcan:file-reference-remove', { detail: { id, path: item.path, chatId } }));
    }
    setContextItems((current) => current.filter((item) => item.id !== id));
  };

  const removeEditContextItem = (id: string) => {
    editComposerRef.current?.removeReferences(id);
    setEditDraft((current) => current ? { ...current, contextItems: current.contextItems.filter((item) => item.id !== id) } : current);
  };

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<MessageFileReference & { chatId?: string }>).detail;
      if (!detail?.path || !chatId || detail.chatId !== chatId) return;
      const { chatId: _chatId, ...reference } = detail;
      const candidate: ComposerContextItem = {
        ...reference,
        id: reference.id || `reference-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
        kind: 'reference',
      };
      if (activeComposerRef.current === 'edit' && editDraftRef.current) {
        setEditDraft((current) => {
          if (!current) return current;
          const existing = current.contextItems.find((item) => item.kind === 'reference' && item.path === candidate.path &&
            item.startLine === candidate.startLine && item.endLine === candidate.endLine && item.revision === candidate.revision);
          return existing ? current : { ...current, contextItems: [...current.contextItems, candidate] };
        });
      } else {
        setContextItems((current) => {
          const existing = current.find((item) => item.kind === 'reference' && item.path === candidate.path &&
            item.startLine === candidate.startLine && item.endLine === candidate.endLine && item.revision === candidate.revision);
          return existing ? current : [...current, candidate];
        });
      }
    };
    window.addEventListener('vulcan:file-reference', receive);
    return () => window.removeEventListener('vulcan:file-reference', receive);
  }, [chatId]);

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<MessageElementReference & { chatId?: string }>).detail;
      if (!detail?.designId || !detail.locator || !detail.hierarchyAddress || !detail.tagName || !chatId || detail.chatId !== chatId) return;
      const { chatId: _chatId, ...element } = detail;
      const candidate: ComposerContextItem = {
        ...element,
        id: element.id || `element-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
        kind: 'element',
      };
      if (activeComposerRef.current === 'edit' && editDraftRef.current) {
        setEditDraft((current) => {
          if (!current) return current;
          const existing = current.contextItems.find((item) => item.kind === 'element' && item.designId === candidate.designId &&
            item.locator === candidate.locator && item.route === candidate.route);
          return existing ? current : { ...current, contextItems: [...current.contextItems, candidate] };
        });
      } else {
        setContextItems((current) => {
          const existing = current.find((item) => item.kind === 'element' && item.designId === candidate.designId &&
            item.locator === candidate.locator && item.route === candidate.route);
          return existing ? current : [...current, candidate];
        });
      }
    };
    window.addEventListener('vulcan:element-reference', receive);
    return () => window.removeEventListener('vulcan:element-reference', receive);
  }, [chatId]);

  const startAttachmentUpload = (file: File): Promise<boolean> => {
    if (uploadedFilesRef.current.has(file)) return Promise.resolve(true);
    const existing = uploadPromisesRef.current.get(file);
    if (existing) return existing;
    if (!uploadsEnabled || !chatId) return Promise.resolve(true);

    const transferId = `upload:${chatId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    uploadTransferIdsRef.current.set(file, transferId);
    const promise = vulcan.uploadAttachment(chatId, file, { transferId })
      .then(() => { uploadedFilesRef.current.add(file); return true; })
      .catch((error) => {
        if (!vulcan.isTransferCancelledError(error)) {
          console.warn(`Failed to upload attachment ${file.name}:`, error);
          toast.error(`Upload failed: ${file.name}`);
        }
        filesRef.current = filesRef.current.filter((item) => item !== file);
        setFiles(filesRef.current);
        editFilesRef.current = editFilesRef.current.filter((item) => item !== file);
        setEditDraft((current) => current ? { ...current, files: current.files.filter((item) => item !== file) } : current);
        return false;
      })
      .finally(() => {
        uploadPromisesRef.current.delete(file);
        uploadTransferIdsRef.current.delete(file);
      });
    uploadPromisesRef.current.set(file, promise);
    return promise;
  };

  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const existingNames = new Set(filesRef.current.map((f) => f.name));
    const deduped = incoming.filter((f) => !existingNames.has(f.name));
    if (deduped.length === 0) return;
    filesRef.current = [...filesRef.current, ...deduped];
    setFiles(filesRef.current);
    for (const file of deduped) void startAttachmentUpload(file);
  };

  const removeFile = (file: File) => {
    uploadedFilesRef.current.delete(file);
    const transferId = uploadTransferIdsRef.current.get(file);
    if (transferId) {
      window.dispatchEvent(new CustomEvent('vulcan-transfer-cancel', { detail: { id: transferId } }));
    }
    filesRef.current = filesRef.current.filter((item) => item !== file);
    setFiles(filesRef.current);
  };


  const addEditFiles = (incoming: File[]) => {
    if (!editDraft || incoming.length === 0) return;
    const existingNames = new Set(editFilesRef.current.map((file) => file.name));
    const deduped = incoming.filter((file) => !existingNames.has(file.name));
    if (!deduped.length) return;
    editFilesRef.current = [...editFilesRef.current, ...deduped];
    setEditDraft((current) => current ? { ...current, files: editFilesRef.current } : current);
    for (const file of deduped) void startAttachmentUpload(file);
  };

  const removeEditFile = (file: File) => {
    uploadedFilesRef.current.delete(file);
    const transferId = uploadTransferIdsRef.current.get(file);
    if (transferId) window.dispatchEvent(new CustomEvent('vulcan-transfer-cancel', { detail: { id: transferId } }));
    editFilesRef.current = editFilesRef.current.filter((item) => item !== file);
    setEditDraft((current) => current ? { ...current, files: editFilesRef.current } : current);
  };

  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const handleChatDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    fileDragCounterRef.current += 1;
    if (fileDragCounterRef.current === 1) setIsDraggingFiles(true);
  };

  const handleChatDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    fileDragCounterRef.current = Math.max(0, fileDragCounterRef.current - 1);
    if (fileDragCounterRef.current === 0) setIsDraggingFiles(false);
  };

  const handleChatDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleChatDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    fileDragCounterRef.current = 0;
    setIsDraggingFiles(false);
    if (activeComposerRef.current === 'edit' && editDraft) addEditFiles(Array.from(e.dataTransfer.files));
    else addFiles(Array.from(e.dataTransfer.files));
  };

  useLayoutEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    const key = transcriptViewId ?? chatId ?? '__new__';
    const controller = new TranscriptScrollController(viewport, {
      onFollowingChange: setFollowingTranscript,
      onSnapshot: (snapshot) => transcriptScrollPositions.set(key, snapshot),
    });
    scrollControllerRef.current = controller;
    const previous = transcriptScrollPositions.get(key);
    setFollowingTranscript(previous?.following ?? true);
    controller.restore(previous);

    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => controller.handleLayoutChange());
    observer?.observe(viewport);
    if (messagesContentRef.current) observer?.observe(messagesContentRef.current);

    const selectionChanged = () => {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      controller.setSelecting(!!selection && !selection.isCollapsed && !!anchor && viewport.contains(anchor));
    };
    document.addEventListener('selectionchange', selectionChanged);

    return () => {
      document.removeEventListener('selectionchange', selectionChanged);
      observer?.disconnect();
      controller.destroy();
      if (scrollControllerRef.current === controller) scrollControllerRef.current = null;
    };
  }, [chatId, transcriptViewId, events.length === 0]);

  useLayoutEffect(() => {
    scrollControllerRef.current?.handleLayoutChange();
  }, [events]);

  const [transfers, setTransfers] = useState<VulcanTransfer[]>([]);
  const [activeTransferIndex, setActiveTransferIndex] = useState(0);
  const [showTransferPrompt, setShowTransferPrompt] = useState(false);
  const transferWheelRef = useRef({ delta: 0, lastAt: 0 });

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail) return;
      const id = String(detail.id ?? 'legacy-transfer');
      if (detail.remove) {
        setTransfers((current) => current.filter((item) => item.id !== id));
        return;
      }
      const next: VulcanTransfer = {
        id,
        filename: String(detail.filename ?? 'workspace-transfer'),
        direction: detail.direction === 'upload' ? 'upload' : 'download',
        percent: Math.max(0, Math.min(100, Number(detail.percent ?? 0))),
        preparing: !!detail.preparing,
      };
      setTransfers((current) => {
        const index = current.findIndex((item) => item.id === id);
        if (index < 0) return [...current, next];
        const copy = [...current];
        copy[index] = next;
        return copy;
      });
    };
    window.addEventListener('vulcan-transfer-progress', handler);
    return () => window.removeEventListener('vulcan-transfer-progress', handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.direction === 'upload' && detail?.filename) {
        toast.success(`Upload Complete: ${detail.filename}`);
      }
    };
    window.addEventListener('vulcan-transfer-complete', handler);
    return () => window.removeEventListener('vulcan-transfer-complete', handler);
  }, []);

  useEffect(() => {
    setActiveTransferIndex((index) => transfers.length ? Math.min(index, transfers.length - 1) : 0);
    if (transfers.length === 0) setShowTransferPrompt(false);
  }, [transfers.length]);

  const cancelTransfer = (id: string) => {
    window.dispatchEvent(new CustomEvent('vulcan-transfer-cancel', { detail: { id } }));
    setTransfers((current) => current.filter((item) => item.id !== id));
  };

  const cycleTransfer = (direction: 1 | -1) => {
    if (transfers.length < 2) return;
    setActiveTransferIndex((index) => (index + direction + transfers.length) % transfers.length);
  };

  const handleTransferWheel = (e: React.WheelEvent) => {
    if (transfers.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    if (now - transferWheelRef.current.lastAt > 180) transferWheelRef.current.delta = 0;
    transferWheelRef.current.lastAt = now;
    transferWheelRef.current.delta += e.deltaY;
    if (Math.abs(transferWheelRef.current.delta) < 40) return;
    cycleTransfer(transferWheelRef.current.delta > 0 ? 1 : -1);
    transferWheelRef.current.delta = 0;
  };

  const activeTransfer = transfers[activeTransferIndex] ?? null;
  // Keep the most recently sent quotation map visible after its composer draft
  // clears, so its original source remains highlighted in the transcript.
  const lastQuotedEvent = [...events].reverse().find(
    (event): event is Extract<ChatEvent, { type: 'user_message' }> => event.type === 'user_message' && !!event.quotes?.length,
  );
  const editingContextItems = editDraft?.contextItems ?? [];
  const editingQuotes = editingContextItems.filter((item): item is MessageQuote & { kind: 'quote' } => item.kind === 'quote');
  const editComposerActive = activeComposerTarget === 'edit' && !!editDraft;
  const highlightedQuotes = editComposerActive && editingQuotes.length > 0 ? editingQuotes : quotes.length > 0 ? quotes : lastQuotedEvent?.quotes ?? [];
  const highlightedContextOrder = editComposerActive && editingQuotes.length > 0 ? editingContextItems.map((item) => item.id) : quotes.length > 0 ? contextOrder : lastQuotedEvent?.contextOrder ?? [];

  const startEditMessage = (message: Message) => {
    if (isProcessing) return;
    const next: EditDraft = {
      messageId: message.id,
      input: message.content ?? '',
      contextItems: messageContextItems(message),
      files: [],
      existingAttachments: [...(message.attachments ?? [])],
    };
    editFilesRef.current = [];
    setEditDraft(next);
    setActiveComposerTarget('edit');
    requestAnimationFrame(() => editComposerRef.current?.focus());
  };

  const cancelEditMessage = () => {
    for (const file of editFilesRef.current) {
      const transferId = uploadTransferIdsRef.current.get(file);
      if (transferId) window.dispatchEvent(new CustomEvent('vulcan-transfer-cancel', { detail: { id: transferId } }));
    }
    editFilesRef.current = [];
    setEditDraft(null);
    setActiveComposerTarget('main');
  };

  const submitEditMessage = async (event: React.FormEvent, submittedFiles: File[]) => {
    event.preventDefault();
    if (!editDraft || isProcessing || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      const readyFiles: File[] = [];
      for (const file of submittedFiles) {
        const ok = await startAttachmentUpload(file);
        if (ok) readyFiles.push(file);
      }
      const text = editDraft.input.trim();
      const items = editDraft.contextItems;
      onEditMessage(editDraft.messageId, {
        content: text,
        attachments: editDraft.existingAttachments.length ? editDraft.existingAttachments : undefined,
        newFiles: readyFiles.length ? readyFiles : undefined,
        ...splitComposerContext(items),
      });
      editFilesRef.current = [];
      setEditDraft(null);
      setActiveComposerTarget('main');
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const handleSubmit = async (e: React.FormEvent, submittedFiles: File[]) => {
    e.preventDefault();
    if ((!stripQuoteReferenceTokens(input).trim() && submittedFiles.length === 0) || isProcessing || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      const readyFiles: File[] = [];
      for (const file of submittedFiles) {
        const ok = await startAttachmentUpload(file);
        if (ok) readyFiles.push(file);
      }
      const text = input.trim();
      if (stripQuoteReferenceTokens(text).trim() || readyFiles.length > 0) {
        scrollControllerRef.current?.resume('smooth');
        onSendMessage(text, readyFiles.length > 0 ? readyFiles : undefined,
          quotes.length ? quotes.map(({ kind: _kind, ...quote }) => quote) : undefined,
          references.length ? references.map(({ kind: _kind, ...reference }) => reference) : undefined,
          contextOrder.length ? contextOrder : undefined,
          elements.length ? elements.map(({ kind: _kind, ...element }) => element) : undefined);
        setInput('');
        setContextItems([]);
      }
      filesRef.current = [];
      setFiles([]);
    } finally {
      submitInFlightRef.current = false;
    }
  };

  return (
    <div
      className="relative h-full flex flex-col bg-ash-950"
      onDragEnter={handleChatDragEnter}
      onDragLeave={handleChatDragLeave}
      onDragOver={handleChatDragOver}
      onDrop={handleChatDrop}
    >
      <style>{`
        @keyframes vulcan-transfer-barber { from { background-position: 0 0; } to { background-position: 28px 0; } }
        @keyframes vulcan-transfer-swap { from { opacity: .55; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      {activeTransfer ? (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-30 w-[330px] max-w-[calc(100%_-_3rem)] select-none" onWheel={handleTransferWheel}>
          {transfers.length > 1 && (
            <div className="pointer-events-none absolute inset-x-[-6px] top-[7px] bottom-[-7px] translate-x-[6px] rounded-xl border border-ash-800 bg-ash-950/90" />
          )}
          <div key={activeTransfer.id} className="relative cursor-pointer rounded-xl border border-ash-700 bg-ash-900/95 px-3 py-3 shadow-2xl backdrop-blur-sm transition-colors hover:bg-ash-800" style={{ animation: 'vulcan-transfer-swap .14s ease-out' }} onClick={() => setShowTransferPrompt(true)} role="button" aria-label="Open active transfers">
            <div className="mb-2 flex items-baseline gap-3">
              <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ash-100">
                {activeTransfer.direction === 'download' ? 'Downloading' : 'Uploading'}: {activeTransfer.filename}
              </div>
              <div className="shrink-0 text-xs tabular-nums text-ash-300">
                {activeTransfer.preparing ? 'Preparing…' : `${Math.round(activeTransfer.percent)}%`}
                {transfers.length > 1 ? ` · ${activeTransferIndex + 1}/${transfers.length}` : ''}
              </div>
            </div>
            <TransferBar transfer={activeTransfer} />
            <div className="mt-2.5 flex justify-center">
              <button type="button" onClick={(e) => { e.stopPropagation(); cancelTransfer(activeTransfer.id); }} className="rounded-lg border border-ash-700 bg-ash-900 px-3.5 py-1.5 text-[11px] text-ash-300 transition-colors hover:bg-ash-800 hover:text-ash-100">Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Messages Area */}
      <div className="relative min-h-0 flex-1">
      <div
        ref={messagesViewportRef}
        className="h-full overflow-y-auto"
        onScroll={() => scrollControllerRef.current?.handleScroll()}
        onWheel={(event) => scrollControllerRef.current?.handleWheel(event.deltaY)}
        onMouseUp={handleQuoteSelection}
        onKeyUp={handleQuoteSelection}
        onContextMenu={handleQuoteSelection}
      >
        {events.length === 0 ? (
          /* ── Welcome screen ── */
          <div className="h-full flex flex-col items-center justify-center p-8 gap-8">
            <div className="text-center">
              <h2 className="text-3xl font-semibold text-ash-100 mb-1">
                Start a New Conversation
              </h2>
              <p className="text-ash-500 text-sm">A workspace will be created with your first message.</p>
            </div>

            {/* Centered input bar on welcome screen */}
            <div className="w-full max-w-2xl">
              <MessageComposer
                input={input}
                setInput={setInput}
                onSubmit={handleSubmit}
                onStop={onStop}
                isProcessing={isProcessing}
                kits={kits}
                onToggleKit={onToggleKit}
                skills={skills}
                onToggleSkill={onToggleSkill}
                files={files}
                addFiles={addFiles}
                removeFile={removeFile}
                isDragging={isDraggingFiles && activeComposerTarget === 'main'}
                contextItems={contextItems}
                onRemoveContextItem={removeContextItem}
                composerRef={composerRef}
                onFocus={() => setActiveComposerTarget('main')}
                compact
              />
            </div>
          </div>
        ) : (
          <div ref={messagesContentRef}>
            <TranscriptRenderer
              key={transcriptViewId ?? chatId ?? '__new__'}
              events={events}
              chatId={chatId}
              kits={kits}
              onToggleKit={onToggleKit}
              onStartEditMessage={startEditMessage}
              editingMessageId={editDraft?.messageId}
              editComposer={editDraft ? (
                <MessageComposer
                  input={editDraft.input}
                  setInput={(value) => setEditDraft((current) => current ? { ...current, input: value } : current)}
                  onSubmit={submitEditMessage}
                  onStop={onStop}
                  isProcessing={isProcessing}
                  kits={kits}
                  onToggleKit={onToggleKit}
                  skills={skills}
                  onToggleSkill={onToggleSkill}
                  files={editDraft.files}
                  addFiles={addEditFiles}
                  removeFile={removeEditFile}
                  existingAttachments={editDraft.existingAttachments}
                  onRemoveExistingAttachment={(index) => setEditDraft((current) => current ? { ...current, existingAttachments: current.existingAttachments.filter((_, currentIndex) => currentIndex !== index) } : current)}
                  isDragging={isDraggingFiles && activeComposerTarget === 'edit'}
                  contextItems={editDraft.contextItems}
                  onRemoveContextItem={removeEditContextItem}
                  composerRef={editComposerRef}
                  onFocus={() => setActiveComposerTarget('edit')}
                  submitLabel="Save & Retry"
                  onCancel={cancelEditMessage}
                />
              ) : null}
              onRetry={onRetry}
              isProcessing={isProcessing}
              quotes={highlightedQuotes}
              contextOrder={highlightedContextOrder}
              scrollElementRef={messagesViewportRef}
              searchQuery={searchQuery}
              activeSearchMatch={activeSearchMatch}
            />
          </div>
        )}
      </div>
      {!followingTranscript && events.length > 0 && (
        <button
          type="button"
          onClick={() => scrollControllerRef.current?.resume('smooth')}
          className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-ash-700 bg-ash-900/95 px-3 py-1.5 text-xs text-ash-200 shadow-lg backdrop-blur-sm transition-colors hover:border-ash-500 hover:bg-ash-800"
          aria-label="Jump to latest message"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          {isProcessing ? 'Follow response' : 'Jump to latest'}
        </button>
      )}
      </div>

      {/* Persistent bottom input — only shown when there are messages */}
      {events.length > 0 && (
        <div className="border-t border-ash-800 bg-ash-900 p-4">
          {questionBatch && onResolveQuestionBatch && (
            <QuestionToolPanel batch={questionBatch} onResolve={onResolveQuestionBatch} />
          )}
          <MessageComposer
            input={input}
            setInput={setInput}
            onSubmit={handleSubmit}
            onStop={onStop}
            isProcessing={isProcessing}
            kits={kits}
            onToggleKit={onToggleKit}
            skills={skills}
            onToggleSkill={onToggleSkill}
            files={files}
            addFiles={addFiles}
            removeFile={removeFile}
            isDragging={isDraggingFiles && activeComposerTarget === 'main'}
            contextItems={contextItems}
            onRemoveContextItem={removeContextItem}
            composerRef={composerRef}
            onFocus={() => setActiveComposerTarget('main')}
          />
        </div>
      )}

      {showTransferPrompt && transfers.length > 0 && (
        <TransferPrompt transfers={transfers} onClose={() => setShowTransferPrompt(false)} onCancel={cancelTransfer} />
      )}
      {(editComposerActive ? editingContextItems : contextItems).length > 0 && <ContextConnections items={editComposerActive ? editingContextItems : contextItems} />}
      {quoteMenu && (
        <div
          className="vulcan-quote-context-menu"
          style={{ left: quoteMenu.x, top: quoteMenu.y }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <div className="vulcan-quote-context-preview">{quoteMenu.quote.text}</div>
          <button type="button" onClick={() => insertQuote(quoteMenu.quote)}>
            <Quote className="h-3.5 w-3.5" /> Quote selection
          </button>
          <button type="button" onClick={() => { void navigator.clipboard.writeText(quoteMenu.quote.text); setQuoteMenu(null); }}>
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
        </div>
      )}
    </div>
  );
}
