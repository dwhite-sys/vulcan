import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bot, ChevronDown, ChevronRight, CircleHelp, FileCode, LayoutDashboard, Monitor, RotateCcw } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ChatMessage, ThinkingStep, ToolStep } from './ChatMessage';
import { RenderToUser, RenderPreview, type RenderType } from './RenderToUser';
import { QuoteSource } from './QuoteSource';
import { QuestionToolPanel } from './QuestionToolPanel';
import type { ChatEvent, Kit, Message, MessageQuote, ReasoningEvent, ToolEvent, UserQuestionAnswer, UserQuestionBatch } from '../types/vulcan';
import { buildTranscriptBlocks, type TranscriptAssistantEvent } from '../services/transcript';
import { isIsolatedMarkdownFence } from '../services/markdownDefense';
import type { TranscriptSearchMatch } from '../services/transcriptSearch';

interface TranscriptRendererProps {
  events: ChatEvent[];
  chatId?: string;
  kits: Kit[];
  onToggleKit: (kitName: string, enabled: boolean) => void;
  onStartEditMessage: (message: Message) => void;
  editingMessageId?: string;
  editComposer?: ReactNode;
  onRetry: (userEventId: string) => void;
  isProcessing?: boolean;
  quotes?: MessageQuote[];
  contextOrder?: string[];
  scrollElementRef: RefObject<HTMLDivElement | null>;
  searchQuery?: string;
  activeSearchMatch?: TranscriptSearchMatch;
  questionBatch?: UserQuestionBatch | null;
  onResolveQuestionBatch?: (answers: Record<string, UserQuestionAnswer>) => void;
}

function toLegacyMessage(event: Extract<ChatEvent, { type: 'user_message' | 'system_message' }>): Message {
  return {
    id: event.id,
    role: event.type === 'user_message' ? 'user' : 'system',
    content: event.content,
    ...(event.type === 'user_message' && event.attachments ? { attachments: event.attachments } : {}),
    ...(event.type === 'user_message' && event.quotes ? { quotes: event.quotes } : {}),
    ...(event.type === 'user_message' && event.references ? { references: event.references } : {}),
    ...(event.type === 'user_message' && event.elements ? { elements: event.elements } : {}),
    ...(event.type === 'user_message' && event.contextOrder ? { contextOrder: event.contextOrder } : {}),
    timestamp: event.timestamp,
  };
}

function toolEventToMessage(event: ToolEvent): Message {
  return {
    id: event.id,
    role: 'tool',
    content: event.status === 'complete' ? `Executed ${event.tool}` : `Calling ${event.tool}...`,
    toolCall: { tool: event.tool, arguments: event.arguments },
    toolResult: event.result,
    toolStatus: event.status,
    timestamp: event.timestamp,
  };
}

function ActionGroup({ events, isProcessing, activeSearchEventId }: { events: (ReasoningEvent | ToolEvent)[]; isProcessing: boolean; activeSearchEventId?: string }) {
  const [open, setOpen] = useState(false);
  const userControlled = useRef(false);
  const active = events.some((e) => e.status === 'streaming' || e.status === 'running');
  const searchForcesOpen = !!activeSearchEventId && events.some((e) => e.id === activeSearchEventId);
  const expanded = searchForcesOpen || open;

  useEffect(() => {
    if (userControlled.current) return;
    setOpen(active);
  }, [active]);

  const hasThought = events.some((e) => e.type === 'reasoning');
  const tools = events.filter((e): e is ToolEvent => e.type === 'tool').map((e) => e.tool);
  const uniqueTools = [...new Set(tools)];
  const labelParts: string[] = [];
  if (hasThought) labelParts.push('Thought');
  if (uniqueTools.length <= 2) labelParts.push(...uniqueTools);
  else if (uniqueTools.length) labelParts.push(`${uniqueTools[0]}, +${uniqueTools.length - 1} more`);
  const label = labelParts.join(' · ') || 'Action';

  return (
    <div className="my-1 border-l-2 border-ash-700/50 ml-1 pl-2">
      <button
        type="button"
        onClick={() => { userControlled.current = true; setOpen((v) => !v); }}
        className="flex items-center gap-2 py-0.5 w-full text-left group/action hover:bg-ash-800/30 rounded transition-colors"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-ash-600" /> : <ChevronRight className="w-3 h-3 text-ash-600" />}
        <span className={`text-xs flex-1 truncate ${active && isProcessing ? 'shimmer' : 'text-ash-500 group-hover/action:text-ash-300'}`}>{label}</span>
        {!expanded && <span className="text-xs text-ash-700 mr-1">{events.length} {events.length === 1 ? 'step' : 'steps'}</span>}
      </button>
      {expanded && (
        <div className="border-l border-ash-800 ml-1.5 space-y-0.5 py-0.5">
          {events.map((event) => event.type === 'reasoning' ? (
            <div key={event.id} data-transcript-search-event-id={event.id}>
            <ThinkingStep
              thinking={event.content}
              streaming={event.status === 'streaming'}
              durationMs={event.completedAt ? event.completedAt.getTime() - event.timestamp.getTime() : undefined}
            />
            </div>
          ) : (
            <div key={event.id} data-transcript-search-event-id={event.id}><ToolStep message={toolEventToMessage(event)} /></div>
          ))}
        </div>
      )}
    </div>
  );
}

// Reserved for the future tool-visualization/history pass. Live `ask_user`
/* interactions intentionally do NOT render through this card: the canonical
 * interactive surface is QuestionToolPanel, routed from the active question
 * batch below. Keep this component until historical tool calls get dedicated UI.
 */
function AskUserCard({ event }: { event: ToolEvent }) {
  const question = String(event.arguments?.question ?? 'Question');
  const options = Array.isArray(event.arguments?.options)
    ? event.arguments.options.slice(0, 5).map((value: unknown) => String(value))
    : [];
  const payload = event.result?.result ?? event.result;
  const result = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const status = result?.status;
  const answer = result?.answer;
  const hasAnswer = status === 'skipped' || (answer !== undefined && answer !== null && String(answer).length > 0);

  return (
    <div className="my-2 rounded-lg border border-ash-700/60 bg-ash-900/35 px-3 py-2.5">
      <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
        <CircleHelp className="mt-0.5 h-3.5 w-3.5 text-coral-400" />
        <div className="min-w-0">
          <div className="text-xs font-medium leading-5 text-ash-300">{question}</div>
          {hasAnswer ? (
            <div className={`text-xs leading-5 ${status === 'skipped' ? 'italic text-ash-600' : 'text-ash-400'}`}>
              {status === 'skipped' ? 'Skipped' : String(answer)}
            </div>
          ) : options.length > 0 ? (
            <div className="mt-1 space-y-1">
              {options.map((option, optionIndex) => (
                <div key={optionIndex} className="flex items-start gap-2 text-xs leading-5 text-ash-400">
                  <span className="w-4 shrink-0 text-right text-ash-600">{optionIndex + 1}.</span>
                  <span className="min-w-0 whitespace-normal break-words">{option}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PresentedFileCard({ event, chatId }: { event: Extract<ChatEvent, { type: 'presented_file' }>; chatId?: string }) {
  const pf = event.file;
  return (
    <div className="my-2 flex items-center gap-3 px-3 py-2.5 bg-ash-800/60 border border-ash-700/60 rounded-lg">
      <FileCode className="w-4 h-4 text-coral-400 flex-shrink-0" />
      <span className="flex-1 min-w-0 text-xs text-ash-200 font-mono truncate" title={pf.path}>{pf.name}</span>
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('vulcan:open-file', { detail: { path: pf.path, chatId } }))}
        className="px-2 py-1 text-xs bg-ash-700 hover:bg-ash-600 text-ash-200 rounded transition-colors"
      >Open</button>
    </div>
  );
}

function PanelCard({ event }: { event: Extract<ChatEvent, { type: 'panel' }> }) {
  return (
    <div className="my-2 flex items-center gap-3 px-3 py-2.5 bg-ash-800/60 border border-ash-700/60 rounded-lg">
      <LayoutDashboard className="w-4 h-4 text-coral-400 flex-shrink-0" />
      <span className="flex-1 min-w-0 text-xs text-ash-200 font-mono truncate">{event.panel.name}</span>
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('vulcan:open-panel', { detail: { name: event.panel.name } }))}
        className="px-2 py-1 text-xs bg-ash-700 hover:bg-ash-600 text-ash-200 rounded transition-colors"
      >Open</button>
    </div>
  );
}

function DesignCard({ event }: { event: ToolEvent }) {
  const name = typeof event.arguments?.name === 'string' && event.arguments.name.trim()
    ? event.arguments.name.trim()
    : 'Design';
  return (
    <div className="my-2 flex items-center gap-3 px-3 py-2.5 bg-ash-800/60 border border-ash-700/60 rounded-lg" data-vulcan-design-attachment={name}>
      <Monitor className="w-4 h-4 text-blue-400 flex-shrink-0" />
      <span className="flex-1 min-w-0 text-xs text-ash-200 font-mono truncate">{name}</span>
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('vulcan:open-design', { detail: { name } }))}
        className="px-2 py-1 text-xs bg-ash-700 hover:bg-ash-600 text-ash-200 rounded transition-colors"
      >Open</button>
    </div>
  );
}

function AssistantRun({ events, chatId, onRetry, isProcessing, quotes, contextOrder, activeSearchEventId, questionBatch, onResolveQuestionBatch }: {
  events: TranscriptAssistantEvent[];
  chatId?: string;
  onRetry?: () => void;
  isProcessing: boolean;
  quotes?: MessageQuote[];
  contextOrder?: string[];
  activeSearchEventId?: string;
  questionBatch?: UserQuestionBatch | null;
  onResolveQuestionBatch?: (answers: Record<string, UserQuestionAnswer>) => void;
}) {
  const renderNodes: ReactNode[] = [];
  const activeQuestionCallIds = new Set(questionBatch?.questions.map((question) => question.toolCallId) ?? []);
  const firstActiveQuestionCallId = events.find(
    (event) => event.type === 'tool' && event.tool === 'ask_user' && activeQuestionCallIds.has(event.callId),
  )?.callId;
  const attachmentNodes = new Map<string, ReactNode>();
  let actionBuffer: (ReasoningEvent | ToolEvent)[] = [];
  const flushActions = () => {
    if (!actionBuffer.length) return;
    const buffered = actionBuffer;
    actionBuffer = [];
    renderNodes.push(<ActionGroup key={`actions-${buffered[0].id}`} events={buffered} isProcessing={isProcessing} activeSearchEventId={activeSearchEventId} />);
  };

  for (const event of events) {
    if (event.type === 'tool' && event.tool === 'preview') {
      flushActions();
      renderNodes.push(
        <RenderPreview
          key={`preview-${event.id}`}
          html={String(event.arguments?.html ?? '')}
          css={String(event.arguments?.css ?? '')}
          js={String(event.arguments?.js ?? '')}
        />
      );
      continue;
    }
    if (event.type === 'tool' && event.tool === 'visualize') {
      flushActions();
      renderNodes.push(
        <RenderToUser
          key={`visualization-${event.id}`}
          content={String(event.arguments?.content ?? '')}
          type={(event.arguments?.type ?? 'svg') as RenderType}
        />
      );
      continue;
    }
    if (
      event.type === 'tool'
      && event.tool === 'ask_user'
      && questionBatch
      && onResolveQuestionBatch
      && activeQuestionCallIds.has(event.callId)
    ) {
      flushActions();
      if (event.callId === firstActiveQuestionCallId) {
        renderNodes.push(
          <QuestionToolPanel
            key={`ask-user-live-${questionBatch.id}`}
            batch={questionBatch}
            onResolve={onResolveQuestionBatch}
          />,
        );
      }
      // One live question batch can contain multiple ask_user tool calls. The
      // panel owns the whole batch, so suppress the sibling raw tool rows.
      continue;
    }
    if (event.type === 'reasoning' || event.type === 'tool') {
      actionBuffer.push(event);
      if (
        event.type === 'tool'
        && event.tool === 'open_design'
        && event.status === 'complete'
        && !event.result?.error
        && !(event.result?.result && typeof event.result.result === 'object' && 'error' in event.result.result)
      ) {
        const name = typeof event.arguments?.name === 'string' ? event.arguments.name.trim() : '';
        if (name) attachmentNodes.set(`design:${name}`, <DesignCard key={`${event.id}:design`} event={event} />);
      }
      continue;
    }
    flushActions();
    if (event.type === 'assistant_text') {
      // Preserve the canonical event, but suppress provider-split bare Markdown fences.
      if (isIsolatedMarkdownFence(event.content)) continue;
      renderNodes.push(
        <div key={event.id} data-transcript-search-event-id={event.id} className={event.status === 'streaming' && isProcessing ? 'shimmer' : ''}>
          <QuoteSource messageId={event.id} role="assistant" quotes={quotes} contextOrder={contextOrder} content={event.content}>
            <MarkdownRenderer content={event.content} />
          </QuoteSource>
        </div>
      );
    } else if (event.type === 'presented_file') {
      attachmentNodes.set(`file:${event.file.path}`, <PresentedFileCard key={event.id} event={event} chatId={chatId} />);
    } else if (event.type === 'panel') {
      attachmentNodes.set(`panel:${event.panel.name}`, <PanelCard key={event.id} event={event} />);
    }
  }
  flushActions();

  // Do not create an empty assistant shell before the first streamed semantic event.
  if (renderNodes.length === 0 && attachmentNodes.size === 0) return null;
  const timestamp = events[events.length - 1]?.timestamp;

  return (
    <div className="group flex gap-3 p-4 bg-ash-900/80">
      <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border-2 bg-ash-100 border-coral-600">
        <Bot className="w-4 h-4 text-ash-900" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-medium text-ash-400 uppercase tracking-wide">Assistant</span>
          {onRetry && !isProcessing && (
            <button onClick={onRetry} className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-ash-500 hover:text-ash-300 hover:bg-ash-700" title="Retry">
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="space-y-2">{renderNodes}</div>
        {attachmentNodes.size > 0 && (
          <div className="mt-3 space-y-2" data-assistant-attachments="true">{[...attachmentNodes.values()]}</div>
        )}
        {timestamp && <div className="text-xs text-ash-600 mt-2">{timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</div>}
      </div>
    </div>
  );
}

const TRANSCRIPT_ESTIMATED_BLOCK_HEIGHT = 240;
const TRANSCRIPT_OVERSCAN_BLOCKS = 2;

function transcriptBlockKey(block: ReturnType<typeof buildTranscriptBlocks>[number], index: number): string {
  if (block.kind === 'single') return block.event.id;
  return block.events[0]?.id ?? `assistant-${index}`;
}

export function TranscriptRenderer(props: TranscriptRendererProps) {
  const blocks = buildTranscriptBlocks(props.events);
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => props.scrollElementRef.current,
    estimateSize: () => TRANSCRIPT_ESTIMATED_BLOCK_HEIGHT,
    overscan: TRANSCRIPT_OVERSCAN_BLOCKS,
    getItemKey: (index) => transcriptBlockKey(blocks[index], index),
  });
  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    if (props.activeSearchMatch) {
      virtualizer.scrollToIndex(props.activeSearchMatch.blockIndex, { align: 'center' });
    }
  }, [props.activeSearchMatch?.id, virtualizer]);

  const lastFlashedSearchMatchRef = useRef<string | null>(null);
  useEffect(() => {
    const match = props.activeSearchMatch;
    if (!match || lastFlashedSearchMatchRef.current === match.id) return;
    const root = props.scrollElementRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(`[data-transcript-block-index="${match.blockIndex}"]`);
    if (!target) return;
    target.animate(
      [{ background: '#3a3321' }, { background: 'transparent' }],
      { duration: 2000, easing: 'ease-out' },
    );
    lastFlashedSearchMatchRef.current = match.id;
  }, [props.activeSearchMatch?.id, props.activeSearchMatch?.blockIndex, props.scrollElementRef, virtualItems.map((item) => item.key).join('|')]);

  useLayoutEffect(() => {
    const cssHighlights = (CSS as any)?.highlights;
    const HighlightCtor = (window as any).Highlight;
    if (!cssHighlights || !HighlightCtor) return;
    cssHighlights.delete('vulcan-transcript-search');
    cssHighlights.delete('vulcan-transcript-search-active');
    const query = props.searchQuery?.trim();
    if (!query) return;

    const allRanges: Range[] = [];
    const activeRanges: Range[] = [];
    const needle = query.toLocaleLowerCase();
    const root = props.scrollElementRef.current;
    if (!root) return;

    root.querySelectorAll<HTMLElement>('[data-transcript-search-event-id]').forEach((eventRoot) => {
      const eventId = eventRoot.dataset.transcriptSearchEventId;
      const eventRanges: Range[] = [];
      const walker = document.createTreeWalker(eventRoot, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? '';
        const lower = text.toLocaleLowerCase();
        let from = 0;
        while (from <= lower.length - needle.length) {
          const start = lower.indexOf(needle, from);
          if (start < 0) break;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + needle.length);
          eventRanges.push(range);
          allRanges.push(range);
          from = start + Math.max(needle.length, 1);
        }
      }
      if (eventId === props.activeSearchMatch?.eventId) {
        const active = eventRanges[props.activeSearchMatch.occurrence];
        if (active) activeRanges.push(active);
      }
    });
    if (allRanges.length) cssHighlights.set('vulcan-transcript-search', new HighlightCtor(...allRanges));
    if (activeRanges.length) cssHighlights.set('vulcan-transcript-search-active', new HighlightCtor(...activeRanges));
    return () => {
      cssHighlights.delete('vulcan-transcript-search');
      cssHighlights.delete('vulcan-transcript-search-active');
    };
  }, [props.searchQuery, props.activeSearchMatch?.id, virtualItems.map((item) => item.key).join('|')]);

  return (
    <>
      <style>{`::highlight(vulcan-transcript-search){background:#8a7629;color:inherit}::highlight(vulcan-transcript-search-active){background:#d4a72c;color:#111}`}</style>
    <div
      data-transcript-virtualized="true"
      data-transcript-total-blocks={blocks.length}
      style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative', width: '100%' }}
    >
      {virtualItems.map((virtualRow) => {
        const block = blocks[virtualRow.index];
        if (!block) return null;
        const key = transcriptBlockKey(block, virtualRow.index);
        return (
          <div
            key={key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            data-transcript-block-index={virtualRow.index}
            data-transcript-block-key={key}
            className={virtualRow.index > 0 ? 'border-t border-zinc-800' : undefined}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {block.kind === 'single' ? (
              <div data-transcript-search-event-id={block.event.id}>
              <ChatMessage
                message={toLegacyMessage(block.event)}
                chatId={props.chatId}
                kits={props.kits}
                onToggleKit={props.onToggleKit}
                onStartEditMessage={block.event.type === 'user_message' ? props.onStartEditMessage : undefined}
                editing={block.event.id === props.editingMessageId}
                editComposer={block.event.id === props.editingMessageId ? props.editComposer : undefined}
                isProcessing={props.isProcessing}
                draftQuotes={props.quotes}
                draftContextOrder={props.contextOrder}
              />
              </div>
            ) : (
              <AssistantRun
                events={block.events}
                chatId={props.chatId}
                onRetry={block.precedingUserId ? () => props.onRetry(block.precedingUserId!) : undefined}
                isProcessing={!!props.isProcessing}
                quotes={props.quotes}
                contextOrder={props.contextOrder}
                activeSearchEventId={props.activeSearchMatch?.eventId}
                questionBatch={props.questionBatch}
                onResolveQuestionBatch={props.onResolveQuestionBatch}
              />
            )}
          </div>
        );
      })}
    </div>
    </>
  );
}
