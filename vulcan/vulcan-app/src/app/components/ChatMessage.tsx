import { useState, useRef, useEffect } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { User, Bot, Wrench, AlertCircle, CheckCircle, ChevronDown, ChevronRight, Copy, Brain, BrainCircuit, Paperclip, Pencil, X, Check, RotateCcw, RotateCcwClock, FileCode, LayoutDashboard, FilePen, Terminal, SquareTerminal, Presentation, Eye, CornerDownLeft, OctagonX, Hourglass, Image, Scan, PackageOpen, PackageSearch, TextSearch, ScanText, CircleHelp, BookOpen, BookCopy, BookSearch, NotebookText, NotepadTextDashed, History, ListCollapse, Diff, Monitor, MonitorUp, MonitorCog, MonitorCheck, Trash2, Library, FileSymlink, MousePointer2, type LucideIcon } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { readFileBase64 } from '../services/vulcan';
import { RenderToUser, type RenderType } from './RenderToUser';
import type { Message, Kit, MessageQuote } from '../types/vulcan';
import { QuoteSource } from './QuoteSource';
import { displayQuotedContent, QUOTE_COLORS } from '../services/quoteProjection';

// ── Image lightbox ────────────────────────────────────────────────────────────
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 p-1.5 rounded-full bg-ash-800/80 text-ash-300 hover:text-white hover:bg-ash-700 transition-colors"
      >
        <X className="w-5 h-5" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

export interface MessageGroup {
  assistant: Message;
  toolSteps: Message[]; // role === 'tool' messages that follow this assistant turn
}

const NATIVE_TOOL_ICONS: Record<string, { icon: LucideIcon; color?: string }> = {
  list_kits: { icon: PackageOpen },
  inspect_kit: { icon: PackageSearch },
  search_tools: { icon: TextSearch },
  inspect_tool: { icon: ScanText },
  run_tool: { icon: Wrench },
  list_skills: { icon: BookCopy },
  search_skills: { icon: BookSearch },
  read_skill: { icon: BookOpen },
  list_skill_files: { icon: NotebookText },
  read_skill_file: { icon: NotepadTextDashed },
  ask_user: { icon: CircleHelp },
  recall: { icon: BrainCircuit, color: 'text-purple-300' },
  library_search: { icon: Library, color: 'text-blue-300' },
  library_attach: { icon: FileSymlink, color: 'text-blue-300' },
  visualize: { icon: Image },
  preview: { icon: Eye },
  get_visualization_width: { icon: Scan },
  open_dashboard: { icon: LayoutDashboard },
  present: { icon: Presentation },
  view_file: { icon: Eye },
  use_terminal: { icon: Terminal },
  send_input: { icon: CornerDownLeft },
  kill_process: { icon: OctagonX, color: 'text-red-400' },
  wait: { icon: Hourglass },
  open_terminal: { icon: SquareTerminal, color: 'text-green-400' },
  close_terminal: { icon: OctagonX, color: 'text-red-400' },
  switch_terminal: { icon: RotateCcw },
  read_output: { icon: ScanText },
  list_terminals: { icon: ListCollapse },
  find_in_file: { icon: TextSearch },
  edit: { icon: FilePen, color: 'text-purple-300' },
  workspace_history: { icon: History },
  workspace_diff: { icon: Diff },
  workspace_restore: { icon: RotateCcwClock },
  dashboard_create: { icon: MonitorUp, color: 'text-green-400' },
  dashboard_update: { icon: MonitorCog },
  dashboard_inspect: { icon: MonitorCheck },
  dashboard_list: { icon: Monitor },
  dashboard_delete: { icon: Trash2, color: 'text-red-400' },
  design_register: { icon: MonitorUp, color: 'text-green-400' },
  design_update: { icon: MonitorCog },
  design_info: { icon: MonitorCheck },
  design_list: { icon: Monitor },
  design_remove: { icon: Trash2, color: 'text-red-400' },
  open_design: { icon: LayoutDashboard },
  design_inspect: { icon: Scan },
  design_click: { icon: MousePointer2 },
  design_fill: { icon: FilePen },
  design_press: { icon: CornerDownLeft },
  design_hover: { icon: MousePointer2 },
  design_scroll: { icon: ChevronDown },
  design_select_option: { icon: Check },
  design_get_text: { icon: TextSearch },
  design_get_attribute: { icon: ScanText },
  design_screenshot: { icon: Image },
};

function NativeToolIcon({ name }: { name: string }) {
  const entry = NATIVE_TOOL_ICONS[name] ?? { icon: Wrench, color: 'text-blue-300' };
  const Icon = entry.icon;
  return <Icon className={`w-3.5 h-3.5 ${entry.color ?? 'text-coral-400'} flex-shrink-0`} />;
}

// A single entry in the interleaved reasoning trace shown under an assistant bubble.
export type RunStep =
  | { kind: 'thinking'; text: string; durationMs?: number }
  | { kind: 'tool'; message: Message }
  | { kind: 'announcement'; text: string };

interface ChatMessageProps {
  message: Message;
  chatId?: string;
  /** Interleaved thinking + tool steps in the order they occurred. */
  steps?: RunStep[];
  kits?: Kit[];
  onToggleKit?: (kitName: string, enabled: boolean) => void;
  onStartEditMessage?: (message: Message) => void;
  editing?: boolean;
  editComposer?: React.ReactNode;
  onRetry?: () => void;
  isProcessing?: boolean;
  draftQuotes?: MessageQuote[];
  draftContextOrder?: string[];
}

// ── Strip thinking block from raw streamed content ────────────────────────────
function parseContent(raw: string): { thinking: string; content: string } {
  // Completed: <think>...</think>content
  const full = raw.match(/^<think>([\s\S]*?)<\/think>([\s\S]*)$/);
  if (full) return { thinking: full[1].trim(), content: full[2].trim() };
  // Still streaming inside think block (no closing tag yet)
  const streaming = raw.match(/^<think>([\s\S]*)$/);
  if (streaming) return { thinking: streaming[1], content: '' };
  return { thinking: '', content: raw };
}

// ── Turn grouping ─────────────────────────────────────────────────────────────

interface Turn {
  steps: RunStep[];
  label: string;
}

function groupStepsIntoTurns(steps: RunStep[]): Turn[] {
  const turns: Turn[] = [];
  let current: RunStep[] = [];

  const flush = () => {
    if (current.length === 0) return;
    turns.push({ steps: current, label: buildTurnLabel(current) });
    current = [];
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // A thinking step after tools in the current turn starts a new turn.
    // Announcement steps always lead their own turn's tools — never flush.
    if (step.kind === 'thinking' && current.some((s) => s.kind === 'tool')) {
      flush();
    }
    current.push(step);
  }
  flush();
  return turns;
}

function buildTurnLabel(steps: RunStep[]): string {
  const parts: string[] = [];
  const hasThinking = steps.some((s) => s.kind === 'thinking');
  const tools = steps.filter((s) => s.kind === 'tool').map((s) => (s as any).message.toolCall?.tool ?? '');

  if (hasThinking) parts.push('Thought');

  if (tools.length > 0) {
    // Deduplicate and summarise tool names
    const unique = [...new Set(tools)];
    if (unique.length <= 2) {
      parts.push(...unique.map((t: string) => t));
    } else {
      parts.push(`${unique[0]}, +${unique.length - 1} more`);
    }
  }

  return parts.join(' · ') || 'Step';
}

// ── Turn group list — manages hover-to-highlight across sibling groups ────────

function TurnGroupList({
  turns,
  isProcessing,
  isStreamingThinking,
}: {
  turns: Turn[];
  isProcessing: boolean;
  isStreamingThinking: boolean;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  return (
    <div className="mb-3 border-l-2 border-ash-700/50 ml-1 space-y-0.5">
      {turns.length === 0 && isStreamingThinking ? (
        <div className="pl-4 -ml-px">
          <ThinkingStep thinking="" streaming={true} />
        </div>
      ) : (
        turns.map((turn, idx) => (
          <TurnGroup
            key={idx}
            turn={turn}
            turnIndex={idx}
            isLast={idx === turns.length - 1}
            isStreaming={isProcessing}
            isStreamingThinking={isStreamingThinking && idx === turns.length - 1}
            dimmed={hoveredIdx !== null && hoveredIdx !== idx}
            onMouseEnter={() => setHoveredIdx(idx)}
            onMouseLeave={() => setHoveredIdx(null)}
          />
        ))
      )}
    </div>
  );
}

function TurnGroup({
  turn,
  isLast,
  isStreaming,
  isStreamingThinking,
  turnIndex,
  dimmed = false,
  onMouseEnter,
  onMouseLeave,
}: {
  turn: Turn;
  isLast: boolean;
  isStreaming: boolean;
  isStreamingThinking: boolean;
  turnIndex: number;
  dimmed?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const [open, setOpen] = useState(isLast);
  const userControlled = useRef(false);

  // Auto-expand when this becomes the active streaming turn;
  // auto-collapse when streaming ends (unless user manually opened it)
  useEffect(() => {
    if (isLast && isStreaming) {
      if (!userControlled.current) setOpen(true);
    } else if (!isStreaming) {
      if (!userControlled.current) setOpen(false);
    }
  }, [isLast, isStreaming]);

  // Split steps by kind
  const announcementSteps = turn.steps.filter((s) => s.kind === 'announcement');
  // Filter out visualize steps — they render outside the group
  const questionSteps = turn.steps.filter(
    (s) => s.kind === 'tool' && (s as any).message.toolCall?.tool === 'ask_user'
  );
  const nonRenderSteps = turn.steps.filter(
    (s) => s.kind !== 'announcement'
      && !(s.kind === 'tool' && (s as any).message.toolCall?.tool === 'visualize')
      && !(s.kind === 'tool' && (s as any).message.toolCall?.tool === 'ask_user')
  );
  const renderSteps = turn.steps.filter(
    (s) => s.kind === 'tool' && (s as any).message.toolCall?.tool === 'visualize'
  );

  const stepCount = nonRenderSteps.length;
  const isActive = isLast && isStreaming;

  return (
    <div
      className={`pl-2 transition-opacity duration-150 ${dimmed && !open ? 'opacity-40' : 'opacity-100'}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Announcement text — model text emitted alongside tool_calls, shown above the group header */}
      {announcementSteps.map((step, idx) => (
        <div
          key={`ann-${idx}`}
          className={`py-0.5 [&_.prose]:text-xs [&_.prose]:text-ash-400 [&_.prose_p]:text-ash-400 [&_.prose_strong]:text-ash-300 [&_.prose_p:first-child]:mt-0 [&_.prose_p:last-child]:mb-0 ${isActive ? 'shimmer' : ''}`}
        >
          <MarkdownRenderer content={(step as any).text} />
        </div>
      ))}

      {/* Inline renders — displayed outside the collapsible group, open by default */}
      {renderSteps.map((step, idx) => {
        const msg = (step as any).message;
        const content = msg.toolCall?.arguments?.content ?? '';
        const type = (msg.toolCall?.arguments?.type ?? 'svg') as RenderType;
        return <RenderToUser key={`render-${idx}`} content={content} type={type} />;
      })}

      {questionSteps.length > 0 && (
        <div className="my-2 space-y-2 rounded-lg border border-ash-700/60 bg-ash-900/35 px-3 py-2.5">
          {questionSteps.map((step, idx) => {
            const msg = (step as any).message as Message;
            const q = String(msg.toolCall?.arguments?.question ?? 'Question');
            const result = msg.toolResult?.result as any;
            const answer = result?.status === 'skipped' ? 'Skipped' : String(result?.answer ?? '');
            return (
              <div key={`question-answer-${idx}`} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
                <CircleHelp className="mt-0.5 h-3.5 w-3.5 text-coral-400" />
                <div className="min-w-0">
                  <div className="text-xs font-medium leading-5 text-ash-300">{q}</div>
                  <div className={`text-xs leading-5 ${result?.status === 'skipped' ? 'italic text-ash-600' : 'text-ash-400'}`}>{answer}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Only render the collapsible group if there are non-render steps */}
      {nonRenderSteps.length > 0 && (
        <>
          {/* Turn header */}
          <button
            onClick={() => { userControlled.current = true; setOpen((v) => !v); }}
            className="flex items-center gap-2 py-0.5 w-full text-left group hover:bg-ash-800/30 rounded transition-colors"
          >
            {open
              ? <ChevronDown className="w-3 h-3 text-ash-600 flex-shrink-0" />
              : <ChevronRight className="w-3 h-3 text-ash-600 flex-shrink-0" />
            }
            <span className={`text-xs flex-1 truncate ${isActive ? 'shimmer' : 'text-ash-500 group-hover:text-ash-300 transition-colors'}`}>
              {turn.label}
            </span>
            {!open && (
              <span className="text-xs text-ash-700 flex-shrink-0 mr-1">
                {stepCount} {stepCount === 1 ? 'step' : 'steps'}
              </span>
            )}
          </button>

          {/* Turn steps */}
          {open && (
            <div className="border-l border-ash-800 ml-1.5 space-y-0.5 py-0.5">
              {nonRenderSteps.map((step, idx) =>
                step.kind === 'thinking' ? (
                  <ThinkingStep
                    key={idx}
                    thinking={step.text}
                    streaming={isStreamingThinking && isLast && idx === nonRenderSteps.length - 1}
                    durationMs={step.durationMs}
                  />
                ) : (
                  <ToolStep key={(step as any).message.id} message={(step as any).message} />
                )
              )}
              {isStreamingThinking && isLast && nonRenderSteps.length === 0 && (
                <ThinkingStep thinking="" streaming={true} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Thinking collapsible ──────────────────────────────────────────────────────
function formatThinkDuration(ms: number): string {
  if (ms < 1000) return 'less than a second';
  const secs = Math.round(ms / 1000);
  return secs === 1 ? '1 second' : `${secs} seconds`;
}

export function ThinkingStep({ thinking, streaming, durationMs }: { thinking: string; streaming?: boolean; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const userControlled = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const [liveElapsed, setLiveElapsed] = useState<number | null>(null);

  // Start timer when streaming begins
  useEffect(() => {
    if (streaming && startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
  }, [streaming]);

  // Freeze live elapsed time when streaming ends
  useEffect(() => {
    if (!streaming && startedAtRef.current !== null && liveElapsed === null) {
      setLiveElapsed(Date.now() - startedAtRef.current);
    }
  }, [streaming, liveElapsed]);

  // Auto-open while actively streaming; auto-close when done (unless user took control)
  useEffect(() => {
    if (streaming) {
      if (!userControlled.current) setOpen(true);
    } else {
      if (!userControlled.current) setOpen(false);
    }
  }, [streaming]);

  const handleToggle = () => {
    userControlled.current = true;
    setOpen((v) => !v);
  };

  if (!thinking && !streaming) return null;

  // Prefer the duration persisted on the canonical reasoning event,
  // fall back to live timer (for the currently streaming step), then generic label.
  const resolvedMs = durationMs ?? liveElapsed;
  const durationLabel = resolvedMs !== null && resolvedMs !== undefined
    ? `Thought for ${formatThinkDuration(resolvedMs)}`
    : 'Thought for a moment';

  return (
    <div className="pl-4 -ml-px">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 py-1 rounded-md hover:bg-ash-800/40 transition-colors w-full text-left group"
      >
        {open
          ? <ChevronDown className="w-3 h-3 text-ash-600 flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 text-ash-600 flex-shrink-0" />}
        <Brain className="w-3.5 h-3.5 text-ash-500 flex-shrink-0" />
        <span className={`text-xs ${streaming ? 'shimmer' : 'text-ash-500 group-hover:text-ash-300 transition-colors'}`}>
          {streaming ? 'Thinking…' : durationLabel}
        </span>
      </button>
      {open && (
        <div className="mt-1 mb-2 pr-1">
          <div className="px-3 py-2 rounded-lg bg-ash-900/60 border border-ash-700/40">
            <p className="text-xs text-ash-500 leading-relaxed whitespace-pre-wrap font-mono">{thinking}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tool call collapsible ─────────────────────────────────────────────────────
export function ToolStep({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const userControlled = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasResult = !!message.toolResult;
  const isInFlight = message.toolStatus
    ? message.toolStatus === 'streaming' || message.toolStatus === 'running'
    : !hasResult;
  const isInterrupted = message.toolStatus === 'interrupted';

  // Auto-open only while genuinely in-flight. A restored interrupted tool must not
  // come back looking like it is still running forever.
  useEffect(() => {
    if (isInFlight) {
      if (!userControlled.current) setOpen(true);
    } else if (!userControlled.current) {
      closeTimerRef.current = setTimeout(() => {
        if (!userControlled.current) setOpen(false);
      }, 500);
    }
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [isInFlight]);

  const handleToggle = () => {
    userControlled.current = true;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setOpen((v) => !v);
  };

  if (!message.toolCall) return null;

  // visualize: show rendered output instead of the normal tool bubble
  if (message.toolCall.tool === 'visualize') {
    const content = message.toolCall.arguments?.content ?? '';
    const type = (message.toolCall.arguments?.type ?? 'svg') as RenderType;
    return <RenderToUser content={content} type={type} />;
  }

  // open_dashboard: show a compact named dashboard card instead of the generic tool bubble
  if (message.toolCall.tool === 'open_dashboard') {
    const name = message.toolCall.arguments?.name ?? 'Dashboard';
    const dashboardHasResult = !!message.toolResult;
    return (
      <div className="pl-4 -ml-px my-1">
        <div className="flex items-center gap-2 px-3 py-2 bg-ash-800/40 border border-ash-700/50 rounded-lg">
          <LayoutDashboard className="w-3.5 h-3.5 text-coral-400 flex-shrink-0" />
          <span className={`text-xs font-mono flex-1 truncate ${isInFlight ? 'shimmer' : 'text-ash-300'}`}>
            {name}
          </span>
          {dashboardHasResult && (
            message.toolResult?.error
              ? <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
              : <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
          )}
        </div>
      </div>
    );
  }

  const isError = !!message.toolResult?.error
    || (message.toolResult?.result != null && typeof message.toolResult.result === 'object' && 'error' in message.toolResult.result);

  // view_file with image result — render image in the expanded result area
  const isImageResult = message.toolCall.tool === 'view_file'
    && message.toolResult?.result?.dataUrl;

  return (
    <div className="pl-4 -ml-px">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 py-1 rounded-md hover:bg-ash-800/40 transition-colors w-full text-left group"
      >
        {open
          ? <ChevronDown className="w-3.5 h-3.5 text-ash-600 flex-shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-ash-600 flex-shrink-0" />}
        <NativeToolIcon name={message.toolCall.tool} />
        <span className={`text-sm font-mono truncate ${
          isInFlight ? 'shimmer' : 'text-ash-300 group-hover:text-ash-100 transition-colors'
        }`}>
          {message.toolCall.tool}
        </span>
        {hasResult ? (
          isError
            ? <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
            : <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
        ) : isInterrupted ? (
          <AlertCircle className="w-3.5 h-3.5 text-ash-500 flex-shrink-0" />
        ) : null}
      </button>
      {open && (
        <div className="mt-1 mb-2 pr-1">
          <div className="rounded-lg border border-ash-700/50 overflow-hidden text-left">
            <div className="px-3 py-2 bg-ash-900/60">
              <div className="text-xs font-medium text-ash-500 uppercase tracking-wide mb-1">Arguments</div>
              <pre className="text-xs text-ash-300 overflow-x-auto">{JSON.stringify(message.toolCall.arguments, null, 2)}</pre>
            </div>
            {message.toolResult && (
              <div className={`border-t border-ash-700/40 ${isError ? 'bg-red-950/20' : 'bg-green-950/10'}`}>
                <div className={`text-xs font-medium uppercase tracking-wide px-3 pt-2 pb-1 ${isError ? 'text-red-400' : 'text-green-400'}`}>
                  {isError ? 'Error' : 'Result'}
                </div>
                {isImageResult ? (
                  <div className="px-3 pb-3">
                    <img
                      src={message.toolResult.result.dataUrl}
                      alt={message.toolResult.result.filename ?? 'viewed file'}
                      className="max-w-full rounded border border-ash-700/40 object-contain max-h-96"
                    />
                    <p className="text-xs text-ash-600 mt-1 font-mono">{message.toolResult.result.filename}</p>
                  </div>
                ) : (
                  <pre className="text-xs text-ash-300 overflow-x-auto max-h-64 px-3 pb-2">
                    {isError ? message.toolResult.error : JSON.stringify(message.toolResult.result, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main message component ────────────────────────────────────────────────────
export function ChatMessage({ message, chatId, steps = [], onStartEditMessage, editing = false, editComposer, onRetry, isProcessing, draftQuotes, draftContextOrder }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);


  // Skip standalone tool messages — they are rendered via toolSteps on the assistant bubble
  if (message.role === 'tool') return null;

  const legacyParsed = message.role === 'assistant'
    ? parseContent(message.content || '')
    : { thinking: '', content: message.content || '' };
  // New messages carry thinking separately. parseContent remains only for old chats /
  // genuinely inline provider output saved before first-class thinking was introduced.
  const inlineThinking = message.role === 'assistant'
    ? (message.thinking || legacyParsed.thinking)
    : '';
  const content = message.role === 'assistant' && message.thinking !== undefined
    ? (message.content || '')
    : legacyParsed.content;

  // Merge inline thinking (from the final assistant turn) into the steps array
  // so it appears after any intermediate tool steps that preceded it.
  const allSteps: RunStep[] = inlineThinking
    ? [...steps, { kind: 'thinking', text: inlineThinking }]
    : steps;

  // isStreamingThinking: true only while the model is actively streaming its think block
  // (thinking present but no final content yet) AND the parent says we're still processing.
  // Without the isProcessing guard, completed messages with thinking-only responses would
  // be stuck in the "Thinking…" shimmer state permanently.
  const isStreamingThinking = inlineThinking.length > 0 && content === '' && message.role === 'assistant' && !!isProcessing;

  if (message.role === 'assistant' && !content && allSteps.length === 0) return null;

  const hasStepsSection = !!(allSteps.length > 0 || isStreamingThinking);

  return (
    <div className={`group flex gap-3 p-4 ${isUser ? 'bg-ash-900/50' : 'bg-ash-900/80'}`}>
      {/* Avatar */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border-2 ${
        isUser
          ? 'bg-white border-coral-500'
          : isSystem
          ? 'bg-ash-700 border-ash-600'
          : 'bg-ash-100 border-coral-600'
      }`}>
        {isUser ? <User className="w-4 h-4 text-ash-900" /> : <Bot className="w-4 h-4 text-ash-900" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header row with label + action buttons */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-medium text-ash-400 uppercase tracking-wide">
            {isUser ? 'User' : isSystem ? 'System' : 'Assistant'}
          </span>
          {isUser && onStartEditMessage && !editing && !isProcessing && (
            <button
              onClick={() => onStartEditMessage?.(message)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-ash-500 hover:text-ash-300 hover:bg-ash-700"
              title="Edit message"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {!isUser && !isSystem && onRetry && !isProcessing && (
            <button
              onClick={onRetry}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-ash-500 hover:text-ash-300 hover:bg-ash-700"
              title="Retry"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Inline edit mode for user messages */}
        {editing ? (
          <div className="flex flex-col gap-2">{editComposer}</div>
        ) : (
          <>
            {/* Thinking + tool steps — grouped into turns, collapsed by default */}
            {hasStepsSection && (() => {
              const turns = groupStepsIntoTurns(allSteps);
              return (
                <TurnGroupList
                  turns={turns}
                  isProcessing={!!isProcessing}
                  isStreamingThinking={isStreamingThinking}
                />
              );
            })()}

            {/* Final response text */}
            {((message.quotes?.length ?? 0) > 0 || (message.references?.length ?? 0) > 0 || (message.elements?.length ?? 0) > 0) && (
              <div className="vulcan-message-quotes" aria-label="Referenced quotations and files">
                {(message.contextOrder?.length ? message.contextOrder : [
                  ...(message.quotes ?? []).map((quote) => quote.id),
                  ...(message.references ?? []).map((reference) => reference.id),
                  ...(message.elements ?? []).map((element) => element.id),
                ]).map((id, index) => {
                  const quote = message.quotes?.find((item) => item.id === id);
                  const reference = message.references?.find((item) => item.id === id);
                  const element = message.elements?.find((item) => item.id === id);
                  if (!quote && !reference && !element) return null;
                  return (
                    <div key={id} className="vulcan-message-quote" style={{ '--quote-color': QUOTE_COLORS[index % QUOTE_COLORS.length] } as React.CSSProperties}>
                      <span className="vulcan-message-quote-number">{index + 1}</span>
                      <span className="vulcan-message-quote-excerpt">{quote ? quote.text : reference ? `${reference.path}${reference.startLine ? `:${reference.startLine}${reference.endLine !== reference.startLine ? `–${reference.endLine}` : ''}` : ''}${reference.revision ? ` @ ${reference.revision.slice(0, 8)}` : ''}` : `${element!.tagName}${element!.text ? ` · ${element!.text}` : ''}`}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {content && (message.role === 'user' || message.role === 'assistant' ? (
              <QuoteSource messageId={message.id} role={message.role} quotes={draftQuotes} contextOrder={draftContextOrder} content={content}>
                <MarkdownRenderer content={displayQuotedContent(content, message.quotes, message.references, message.contextOrder, message.elements)} />
              </QuoteSource>
            ) : <MarkdownRenderer content={content} />)}

            {/* Presented file cards — files the agent called present() on */}
            {message.presentedFiles && message.presentedFiles.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {message.presentedFiles.map((pf, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-3 py-2.5 bg-ash-800/60 border border-ash-700/60 rounded-lg"
                  >
                    <FileCode className="w-4 h-4 text-coral-400 flex-shrink-0" />
                    <span className="flex-1 min-w-0 text-xs text-ash-200 font-mono truncate" title={pf.path}>
                      {pf.name}
                    </span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => {
                          // Open in Monaco via custom event
                          window.dispatchEvent(new CustomEvent('vulcan:open-file', { detail: { path: pf.path, chatId: (pf as any).chatId } }));
                        }}
                        className="px-2 py-1 text-xs bg-ash-700 hover:bg-ash-600 text-ash-200 rounded transition-colors"
                      >
                        Open
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            if (!chatId) return;
                            const { base64, mimeType } = await readFileBase64(chatId, pf.path);
                            const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = pf.name;
                            a.click();
                            URL.revokeObjectURL(url);
                          } catch { /* ignore */ }
                        }}
                        className="px-2 py-1 text-xs bg-ash-700 hover:bg-ash-600 text-ash-200 rounded transition-colors"
                      >
                        Download
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Dashboard cards — dashboards opened by agent in this turn */}
            {message.panels && message.panels.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {message.panels.map((panel, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-3 py-2.5 bg-ash-800/60 border border-ash-700/60 rounded-lg"
                  >
                    <LayoutDashboard className="w-4 h-4 text-coral-400 flex-shrink-0" />
                    <span className="flex-1 min-w-0 text-xs text-ash-200 font-mono truncate">
                      {panel.name}
                    </span>
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent('vulcan:open-panel', { detail: { name: panel.name } }))}
                      className="px-2 py-1 text-xs bg-ash-700 hover:bg-ash-600 text-ash-200 rounded transition-colors flex-shrink-0"
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Attachments — images as thumbnails (click to enlarge), other files as chips */}
            {message.attachments && message.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.attachments.map((a, i) =>
                  a.dataUrl ? (
                    <button
                      key={i}
                      onClick={() => setLightbox({ src: a.dataUrl!, alt: a.name })}
                      className="rounded-md overflow-hidden focus:outline-none focus:ring-2 focus:ring-coral-500 hover:opacity-90 transition-opacity"
                      title={`${a.name} — click to enlarge`}
                    >
                      <img
                        src={a.dataUrl}
                        alt={a.name}
                        className="object-cover"
                        style={{ width: '80px', height: '80px' }}
                      />
                    </button>
                  ) : (
                    <span key={i} className="flex items-center gap-1 text-xs bg-ash-800 border border-ash-700 text-ash-300 px-2 py-1 rounded-md">
                      <Paperclip className="w-3 h-3 text-ash-500" />
                      {a.name}
                      <span className="text-ash-500 ml-1">{(a.size / 1024).toFixed(1)} KB</span>
                    </span>
                  )
                )}
              </div>
            )}

            {/* Lightbox */}
            {lightbox && (
              <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
            )}
          </>
        )}

        <div className="text-xs text-ash-600 mt-2">
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
