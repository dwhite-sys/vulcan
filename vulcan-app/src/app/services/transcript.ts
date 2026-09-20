import type { AssistantTextEvent, ChatEvent, ReasoningEvent, ToolEvent } from '../types/vulcan';
import type { LLMStreamEvent } from './llm';

export type TranscriptSingleEvent = Extract<ChatEvent, { type: 'user_message' | 'system_message' }>;
export type TranscriptAssistantEvent = Exclude<ChatEvent, TranscriptSingleEvent>;

export type TranscriptBlock =
  | { kind: 'single'; event: TranscriptSingleEvent }
  | { kind: 'assistant_run'; events: TranscriptAssistantEvent[]; precedingUserId?: string };

/**
 * The renderer is a projection of the persisted event array, never a restorer.
 * This function may GROUP adjacent events into visual bubbles, but it is forbidden
 * from reordering, dropping, or synthesizing semantic transcript events.
 */
export function buildTranscriptBlocks(events: ChatEvent[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let run: TranscriptAssistantEvent[] = [];
  let precedingUserId: string | undefined;

  const flushRun = () => {
    if (run.length === 0) return;
    blocks.push({ kind: 'assistant_run', events: run, precedingUserId });
    run = [];
  };

  for (const event of events) {
    if (event.type === 'user_message' || event.type === 'system_message') {
      flushRun();
      blocks.push({ kind: 'single', event });
      if (event.type === 'user_message') precedingUserId = event.id;
      continue;
    }
    run.push(event);
  }

  flushRun();
  return blocks;
}

/**
 * A tiny serializable description of what the transcript renderer is allowed to
 * group. Semantic text, actions, and visualizations retain their exact chronology;
 * dashboard/file attachment cards are projected into their assistant-message footer.
 */
export type RenderAtom =
  | { kind: 'single'; id: string; type: 'user_message' | 'system_message' }
  | { kind: 'actions'; ids: string[] }
  | { kind: 'visualization'; id: string }
  | { kind: 'assistant_text'; id: string }
  | { kind: 'presented_file'; id: string }
  | { kind: 'panel'; id: string }
  | { kind: 'design'; id: string };

export function projectRenderAtoms(events: ChatEvent[]): RenderAtom[] {
  const atoms: RenderAtom[] = [];

  for (const block of buildTranscriptBlocks(events)) {
    if (block.kind === 'single') {
      atoms.push({ kind: 'single', id: block.event.id, type: block.event.type });
      continue;
    }

    let actionIds: string[] = [];
    const attachments = new Map<string, RenderAtom>();
    const flushActions = () => {
      if (actionIds.length === 0) return;
      atoms.push({ kind: 'actions', ids: actionIds });
      actionIds = [];
    };

    for (const event of block.events) {
      if (event.type === 'tool' && event.tool === 'visualize') {
        flushActions();
        atoms.push({ kind: 'visualization', id: event.id });
        continue;
      }
      if (event.type === 'reasoning' || event.type === 'tool') {
        actionIds.push(event.id);
        if (event.type === 'tool' && event.tool === 'open_design' && event.status === 'complete') {
          const name = typeof event.arguments?.name === 'string' ? event.arguments.name.trim() : '';
          if (name && !event.result?.error && !(event.result?.result && typeof event.result.result === 'object' && 'error' in event.result.result)) {
            attachments.set(`design:${name}`, { kind: 'design', id: event.id });
          }
        }
        continue;
      }

      flushActions();
      if (event.type === 'assistant_text') atoms.push({ kind: 'assistant_text', id: event.id });
      else if (event.type === 'presented_file') attachments.set(`file:${event.file.path}`, { kind: 'presented_file', id: event.id });
      else if (event.type === 'panel') attachments.set(`panel:${event.panel.name}`, { kind: 'panel', id: event.id });
    }

    flushActions();
    atoms.push(...attachments.values());
  }

  return atoms;
}

/** Rehydrate the exact canonical event schema written to chat.json. */
export function rehydrateChatEvents(rawEvents: unknown, recoverInterrupted = false): ChatEvent[] {
  if (!Array.isArray(rawEvents)) return [];

  return rawEvents.map((raw: any) => {
    const transient = raw?.status === 'streaming' || raw?.status === 'running';
    const status = recoverInterrupted && transient ? 'interrupted' : raw?.status;
    return {
      ...raw,
      ...(status ? { status } : {}),
      timestamp: new Date(raw.timestamp),
      ...(raw.completedAt ? { completedAt: new Date(raw.completedAt) } : {}),
      ...(raw.file?.presentedAt
        ? { file: { ...raw.file, presentedAt: new Date(raw.file.presentedAt) } }
        : {}),
      ...(raw.panel?.updatedAt
        ? { panel: { ...raw.panel, updatedAt: new Date(raw.panel.updatedAt) } }
        : {}),
    } as ChatEvent;
  });
}

// ── Streaming reducer ────────────────────────────────────────────────────────
// The streaming reducer is deliberately UI-agnostic. Provider deltas update the
// same ChatEvent[] that is persisted and rendered. Only contents/status of an
// existing event may change; its array position never does.


export interface TurnStreamState {
  events: ChatEvent[];
  activeSemanticId: string | null;
  activeSemanticType: 'reasoning' | 'assistant_text' | null;
  toolEventIds: Map<number, string>;
}

export interface TurnStreamContext {
  runId: string;
  turnId: string;
  makeId?: (kind: string) => string;
}

function defaultStreamEventId(turnId: string, kind: string) {
  return `${turnId}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

export function createTurnStreamState(events: ChatEvent[]): TurnStreamState {
  return {
    events,
    activeSemanticId: null,
    activeSemanticType: null,
    toolEventIds: new Map(),
  };
}

export function sealTurnSemantic(
  state: TurnStreamState,
  status: 'complete' | 'interrupted' = 'complete',
): TurnStreamState {
  if (!state.activeSemanticId) return state;
  const activeId = state.activeSemanticId;
  const now = new Date();
  const events = state.events.map((event) => {
    if (event.id !== activeId) return event;
    if (event.type === 'reasoning') return { ...event, status, completedAt: now } as ReasoningEvent;
    if (event.type === 'assistant_text') return { ...event, status } as AssistantTextEvent;
    return event;
  });
  return { ...state, events, activeSemanticId: null, activeSemanticType: null };
}

export function applyLLMStreamEvent(
  inputState: TurnStreamState,
  streamEvent: LLMStreamEvent,
  context: TurnStreamContext,
): TurnStreamState {
  const makeId = context.makeId ?? ((kind: string) => defaultStreamEventId(context.turnId, kind));
  let state = inputState;

  if (streamEvent.type === 'reasoning_delta' || streamEvent.type === 'text_delta') {
    const semanticType = streamEvent.type === 'reasoning_delta' ? 'reasoning' : 'assistant_text';
    const delta = streamEvent.delta;
    if (!delta) return state;

    if (state.activeSemanticType !== semanticType || !state.activeSemanticId) {
      state = sealTurnSemantic(state);
      const id = makeId(semanticType);
      const event: ReasoningEvent | AssistantTextEvent = semanticType === 'reasoning'
        ? {
            id,
            type: 'reasoning',
            content: delta,
            status: 'streaming',
            timestamp: new Date(),
            runId: context.runId,
            turnId: context.turnId,
            ...(streamEvent.type === 'reasoning_delta' && streamEvent.wire ? { reasoningWire: streamEvent.wire } : {}),
            ...(streamEvent.type === 'reasoning_delta' && streamEvent.details ? { reasoningDetails: [...streamEvent.details] } : {}),
          }
        : {
            id,
            type: 'assistant_text',
            content: delta,
            status: 'streaming',
            timestamp: new Date(),
            runId: context.runId,
            turnId: context.turnId,
          };
      return {
        ...state,
        events: [...state.events, event],
        activeSemanticId: id,
        activeSemanticType: semanticType,
      };
    }

    const activeId = state.activeSemanticId;
    const events = state.events.map((event) => {
      if (event.id !== activeId) return event;
      if (event.type === 'reasoning' && streamEvent.type === 'reasoning_delta') {
        return {
          ...event,
          content: event.content + delta,
          reasoningWire: event.reasoningWire ?? streamEvent.wire,
          reasoningDetails: streamEvent.details
            ? [...(event.reasoningDetails ?? []), ...streamEvent.details]
            : event.reasoningDetails,
        };
      }
      if (event.type === 'assistant_text' && streamEvent.type === 'text_delta') {
        return { ...event, content: event.content + delta };
      }
      return event;
    });
    return { ...state, events };
  }

  // A tool call starts a new immutable transcript position. Any currently streamed
  // reasoning/text segment is sealed before the tool event is appended.
  state = sealTurnSemantic(state);
  const index = Number.isInteger(streamEvent.index) ? streamEvent.index : 0;
  const existingId = state.toolEventIds.get(index);

  if (!existingId) {
    const id = makeId(`tool:${index}`);
    const rawArguments = streamEvent.argumentsDelta ?? '';
    let parsedArguments: Record<string, any> = {};
    try { parsedArguments = JSON.parse(rawArguments || '{}'); } catch { /* incomplete while streaming */ }
    const event: ToolEvent = {
      id,
      type: 'tool',
      callId: streamEvent.id ?? `${context.turnId}:call:${index}`,
      tool: streamEvent.nameDelta ?? '',
      arguments: parsedArguments,
      rawArguments,
      status: 'streaming',
      timestamp: new Date(),
      runId: context.runId,
      turnId: context.turnId,
    };
    const toolEventIds = new Map(state.toolEventIds);
    toolEventIds.set(index, id);
    return { ...state, events: [...state.events, event], toolEventIds };
  }

  const events = state.events.map((event) => {
    if (event.id !== existingId || event.type !== 'tool') return event;
    const rawArguments = (event.rawArguments ?? '') + (streamEvent.argumentsDelta ?? '');
    let parsedArguments = event.arguments;
    try { parsedArguments = JSON.parse(rawArguments || '{}'); } catch { /* incomplete while streaming */ }
    return {
      ...event,
      callId: streamEvent.id || event.callId,
      tool: event.tool + (streamEvent.nameDelta ?? ''),
      rawArguments,
      arguments: parsedArguments,
    };
  });
  return { ...state, events };
}
