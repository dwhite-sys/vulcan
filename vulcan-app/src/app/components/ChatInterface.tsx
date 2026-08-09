import { useState, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import * as vulcan from '../services/vulcan';
import { Send, Paperclip, Square, FileText, FileCode, FileArchive, File, X, ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { ChatMessage } from './ChatMessage';
import type { RunStep } from './ChatMessage';
import { KitToggleMenu } from './KitToggleMenu';
import { SkillToggleMenu } from './SkillToggleMenu';
import type { SkillMeta } from './SkillToggleMenu';
import type { Message, Kit, PresentedFile, Panel, UserQuestionBatch, UserQuestionAnswer } from '../types/vulcan';

// ── Group an entire agentic run into a single assistant bubble ────────────────
// An agentic run is: assistant? → [tool* → assistant]* → final assistant
// We merge all intermediate assistant messages (which carry thinking) and all
// tool messages into a single rendered group whose "message" is the last
// assistant turn (the one with actual content / no tool_calls pending).
// Steps are kept in the order they actually occurred (think → tool → think → tool…).
function groupMessages(messages: Message[]): { message: Message; steps: RunStep[] }[] {
  const groups: { message: Message; steps: RunStep[] }[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    // Non-assistant messages are standalone groups (user, system, tool orphans)
    if (msg.role !== 'assistant') {
      if (msg.role !== 'tool') {
        groups.push({ message: msg, steps: [] });
      }
      i++;
      continue;
    }

    // Start of an assistant run — consume everything until there are no more
    // tool messages following (i.e. we've reached the final assistant turn).
    const steps: RunStep[] = [];
    let lastAssistant = msg;
    // Accumulate presentedFiles across every assistant turn in this run so cards
    // always appear on the rendered (final) assistant bubble regardless of which
    // intermediate turn called present(). Dedup by path; last occurrence wins.
    const presentedByPath = new Map<string, PresentedFile>();
    // Same for panels — dedup by name, last occurrence wins.
    const panelsByName = new Map<string, Panel>();

    while (i < messages.length) {
      const cur = messages[i];
      if (cur.role === 'assistant') {
        lastAssistant = cur;
        i++;
        // Collect presentedFiles from this assistant turn
        for (const pf of cur.presentedFiles ?? []) {
          presentedByPath.set(pf.path, pf);
        }
        // Collect panels from this assistant turn
        for (const p of cur.panels ?? []) {
          panelsByName.set(p.name, p);
        }
        // Collect any tool messages that follow this assistant turn
        const stepsForThisTurn: Message[] = [];
        while (i < messages.length && messages[i].role === 'tool') {
          stepsForThisTurn.push(messages[i]);
          i++;
        }
        const isIntermediateTurn = stepsForThisTurn.length > 0 || (i < messages.length && messages[i].role === 'assistant');
        // Only extract thinking/announcements from intermediate turns — the final turn's
        // thinking is appended by ChatMessage itself (via parseContent) so we skip it here.
        if (isIntermediateTurn) {
          // Announcement: model emitted plain text alongside tool_calls in this turn.
          // Strip any think tags to get the bare text, then emit it before the collapsible.
          if ((cur as any).isAnnouncement) {
            const raw = cur.content || '';
            const withoutThink = raw.replace(/^<think>[\s\S]*?<\/think>/i, '').trim();
            if (withoutThink) {
              steps.push({ kind: 'announcement', text: withoutThink });
            }
          }
          const { thinking } = parseThinking(cur.content || '');
          if (thinking) {
            // Compute duration: time between this assistant message and the first
            // tool result (or next assistant turn) that followed it.
            const endMsg = stepsForThisTurn[0] ?? (i < messages.length ? messages[i] : null);
            const durationMs = endMsg
              ? new Date(endMsg.timestamp).getTime() - new Date(cur.timestamp).getTime()
              : undefined;
            steps.push({ kind: 'thinking', text: thinking, durationMs });
          }
        }
        // Tool steps follow the thinking/announcement that caused them — preserving order.
        for (const t of stepsForThisTurn) steps.push({ kind: 'tool', message: t });
        // If the next message is another assistant turn, keep looping (multi-turn)
        if (i < messages.length && messages[i].role === 'assistant') continue;
        // Otherwise we're done with this run
        break;
      } else {
        break;
      }
    }

    // Splice merged presentedFiles and panels onto lastAssistant
    const mergedPresentedFiles = [...presentedByPath.values()];
    const mergedPanels = [...panelsByName.values()];
    const renderedMessage = (mergedPresentedFiles.length > 0 || mergedPanels.length > 0)
      ? {
          ...lastAssistant,
          ...(mergedPresentedFiles.length > 0 ? { presentedFiles: mergedPresentedFiles } : {}),
          ...(mergedPanels.length > 0 ? { panels: mergedPanels } : {}),
        }
      : lastAssistant;

    groups.push({ message: renderedMessage, steps });
  }
  return groups;
}

// Thin helper used by groupMessages (mirrors parseContent in ChatMessage)
function parseThinking(raw: string): { thinking: string } {
  const full = raw.match(/^<think>([\s\S]*?)<\/think>/);
  if (full) return { thinking: full[1].trim() };
  const streaming = raw.match(/^<think>([\s\S]*)$/);
  if (streaming) return { thinking: streaming[1] };
  return { thinking: '' };
}

interface ChatInterfaceProps {
  chatId?: string;
  chatTitle?: string;
  isGlobal?: boolean;
  messages: Message[];
  kits: Kit[];
  onSendMessage: (content: string, attachments?: File[]) => void;
  onToggleKit: (kitName: string, enabled: boolean) => void;
  skills: SkillMeta[];
  onToggleSkill: (stem: string, enabled: boolean) => void;
  onStop: () => void;
  onEditMessage: (messageId: string, newContent: string, attachments?: File[]) => void;
  onRetry: (userMessageId: string) => void;
  isProcessing?: boolean;
  uploadsEnabled?: boolean;
  questionBatch?: UserQuestionBatch | null;
  onResolveQuestionBatch?: (answers: Record<string, UserQuestionAnswer>) => void;
}

// ── Attachment chip helpers ───────────────────────────────────────────────────

type FileKind = 'image' | 'pdf' | 'text' | 'code' | 'archive' | 'other';

function classifyFile(f: File): FileKind {
  if (f.type.startsWith('image/')) return 'image';
  if (f.type === 'application/pdf') return 'pdf';
  if (f.type.startsWith('text/') || /\.(txt|md|csv|log|json|yaml|yml|toml|xml)$/i.test(f.name)) return 'text';
  if (/\.(js|ts|tsx|jsx|py|rb|go|rs|c|cpp|h|java|swift|kt|sh|bash|zsh|fish|css|html|htm|sql)$/i.test(f.name)) return 'code';
  if (/\.(zip|tar|gz|bz2|xz|7z|rar)$/i.test(f.name)) return 'archive';
  return 'other';
}

function FileKindIcon({ kind }: { kind: FileKind }) {
  switch (kind) {
    case 'pdf':     return <FileText className="w-4 h-4 text-red-400 shrink-0" />;
    case 'text':    return <FileText className="w-4 h-4 text-ash-300 shrink-0" />;
    case 'code':    return <FileCode className="w-4 h-4 text-blue-400 shrink-0" />;
    case 'archive': return <FileArchive className="w-4 h-4 text-yellow-400 shrink-0" />;
    default:        return <File className="w-4 h-4 text-ash-400 shrink-0" />;
  }
}

function AttachmentChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const kind = classifyFile(file);

  if (kind === 'image') {
    const url = URL.createObjectURL(file);
    return (
      <div className="relative group flex flex-col items-center gap-1 bg-ash-700 rounded-lg p-1.5 w-20 shrink-0">
        <img
          src={url}
          alt={file.name}
          className="w-16 h-16 object-cover rounded-md"
          onLoad={() => URL.revokeObjectURL(url)}
        />
        <span className="text-[10px] text-ash-300 truncate w-full text-center leading-tight">{file.name}</span>
        <button
          type="button"
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-ash-600 hover:bg-red-600 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="w-2.5 h-2.5 text-ash-100" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative group flex items-center gap-2 bg-ash-700 text-ash-300 px-2.5 py-1.5 rounded-lg max-w-[180px]">
      <FileKindIcon kind={kind} />
      <span className="text-xs truncate">{file.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 text-ash-500 hover:text-ash-100 shrink-0 transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function InputBar({
  input,
  setInput,
  onSubmit,
  onStop,
  isProcessing,
  kits,
  onToggleKit,
  skills,
  onToggleSkill,
  files,
  setFiles,
  addFiles,
  removeFile,
  isDragging,
  compact = false,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: (e: React.FormEvent, files: File[]) => void;
  onStop: () => void;
  isProcessing?: boolean;
  kits: Kit[];
  onToggleKit: (kitName: string, enabled: boolean) => void;
  skills: SkillMeta[];
  onToggleSkill: (stem: string, enabled: boolean) => void;
  files: File[];
  setFiles: React.Dispatch<React.SetStateAction<File[]>>;
  addFiles: (incoming: File[]) => void;
  removeFile: (file: File) => void;
  isDragging: boolean;
  compact?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
  };

  const PASTE_TEXT_THRESHOLD = 500; // chars; below this → inline, above → .txt attachment

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);

    // Files take priority (images, dragged files, etc.)
    const pastedFiles = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      addFiles(pastedFiles);
      return;
    }

    // Plain text paste — inline if short, synthetic .txt if long
    const text = e.clipboardData.getData('text/plain');
    if (text && text.length > PASTE_TEXT_THRESHOLD) {
      e.preventDefault();
      const blob = new Blob([text], { type: 'text/plain' });
      const syntheticFile = new File([blob], 'pasted-text.txt', { type: 'text/plain' });
      addFiles([syntheticFile]);
    }
    // else: let the browser handle it normally (inserts into input)
  };

  const handleSubmit = (e: React.FormEvent) => {
    onSubmit(e, files);
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={compact ? '' : 'w-full'}
    >
      <div className={`relative flex flex-col bg-ash-800 border rounded-xl focus-within:ring-2 focus-within:ring-coral-600 transition-all ${isDragging ? 'border-coral-500 ring-2 ring-coral-500/40' : 'border-ash-700'} ${compact ? '' : 'shadow-lg'}`}>
        {/* Drag-and-drop overlay */}
        {isDragging && (
          <div className="absolute inset-0 rounded-xl bg-coral-500/10 border-2 border-coral-500 border-dashed flex items-center justify-center pointer-events-none z-10">
            <span className="text-coral-400 text-sm font-medium">Drop files to attach</span>
          </div>
        )}

        {/* File preview strip */}
        {files.length > 0 && (
          <div className="flex flex-wrap items-end gap-2 px-4 pt-3">
            {files.map((f, i) => (
              <AttachmentChip
                key={i}
                file={f}
                onRemove={() => removeFile(f)}
              />
            ))}
          </div>
        )}

        {/* Text input row */}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handlePaste}
          placeholder="Type your message..."
          disabled={isProcessing}
          className="flex-1 px-4 py-3 bg-transparent text-ash-100 placeholder-zinc-500 focus:outline-none disabled:opacity-50 text-sm"
        />

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-3 pb-2">
          <div className="flex items-center gap-1">
            {/* Attach file */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-1.5 text-ash-400 hover:text-ash-200 hover:bg-ash-700 rounded-md transition-colors"
              title="Attach files"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            {/* Kits menu */}
            <KitToggleMenu kits={kits} onToggleKit={onToggleKit} />
            {/* Skills menu */}
            <SkillToggleMenu skills={skills} onToggleSkill={onToggleSkill} />
          </div>

          {/* Stop / Send button */}
          {isProcessing ? (
            <button
              type="button"
              onClick={onStop}
              className="p-2 bg-ash-700 text-white rounded-lg hover:bg-red-600 transition-colors flex items-center justify-center"
              title="Stop generation"
            >
              <Square className="w-4 h-4 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={(!input.trim() && files.length === 0)}
              className="p-2 bg-coral-500 text-white rounded-lg hover:bg-coral-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
              title="Send"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
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
  chatTitle = 'New Chat',
  isGlobal = false,
  messages,
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
}: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileDragCounterRef = useRef(0);
  const filesRef = useRef<File[]>([]);
  const uploadPromisesRef = useRef(new Map<File, Promise<boolean>>());
  const uploadedFilesRef = useRef(new Set<File>());
  const uploadTransferIdsRef = useRef(new Map<File, string>());
  const submitInFlightRef = useRef(false);

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
        setFiles((current) => current.filter((item) => item !== file));
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
    addFiles(Array.from(e.dataTransfer.files));
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

  const handleSubmit = async (e: React.FormEvent, submittedFiles: File[]) => {
    e.preventDefault();
    if ((!input.trim() && submittedFiles.length === 0) || isProcessing || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      const readyFiles: File[] = [];
      for (const file of submittedFiles) {
        const ok = await startAttachmentUpload(file);
        if (ok) readyFiles.push(file);
      }
      const text = input.trim();
      if (text || readyFiles.length > 0) {
        onSendMessage(text, readyFiles.length > 0 ? readyFiles : undefined);
        setInput('');
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
      ) : isGlobal && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none select-none text-sm font-medium tracking-wide text-ash-500">
          [ Global Container ]
        </div>
      )}

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
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
              <InputBar
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
                setFiles={setFiles}
                addFiles={addFiles}
                removeFile={removeFile}
                isDragging={isDraggingFiles}
                compact
              />
            </div>
          </div>
        ) : (
          <div className="divide-y divide-zinc-800">
            {groupMessages(messages).map(({ message, steps }) => {
              // For assistant groups, find the closest preceding user message for retry
              let retryHandler: (() => void) | undefined;
              if (message.role === 'assistant') {
                // Walk backwards through the flat messages array to find the last user message
                const assistantIdx = messages.findIndex((m) => m.id === message.id);
                for (let i = assistantIdx - 1; i >= 0; i--) {
                  if (messages[i].role === 'user') {
                    const userMsg = messages[i];
                    retryHandler = () => onRetry(userMsg.id);
                    break;
                  }
                }
              }
              return (
                <ChatMessage
                  key={message.id}
                  message={message}
                  chatId={chatId}
                  steps={steps}
                  kits={kits}
                  onToggleKit={onToggleKit}
                  onEditMessage={onEditMessage}
                  onRetry={retryHandler}
                  isProcessing={isProcessing}
                />
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Persistent bottom input — only shown when there are messages */}
      {messages.length > 0 && (
        <div className="border-t border-ash-800 bg-ash-900 p-4">
          {questionBatch && onResolveQuestionBatch && (
            <QuestionToolPanel batch={questionBatch} onResolve={onResolveQuestionBatch} />
          )}
          <InputBar
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
            setFiles={setFiles}
            addFiles={addFiles}
            removeFile={removeFile}
            isDragging={isDraggingFiles}
          />
        </div>
      )}

      {showTransferPrompt && transfers.length > 0 && (
        <TransferPrompt transfers={transfers} onClose={() => setShowTransferPrompt(false)} onCancel={cancelTransfer} />
      )}
    </div>
  );
}
