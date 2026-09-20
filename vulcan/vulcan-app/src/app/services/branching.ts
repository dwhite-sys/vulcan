import type { BranchEventNode, BranchOrigin, BranchRecord, BranchingState, Chat, ChatEvent, UserMessageEvent } from '../types/vulcan';

const STOP = new Set([
  'the','and','that','this','with','from','have','just','like','about','into','your','you','for','are','was','were','but','not','can','could','would','should','there','their','they','them','then','than','what','when','where','which','while','who','why','how','its','our','out','too','very','more','some','thing','things','make','made','does','did','doing','also','really','actually','basically','okay','yeah','yes','no','want','think','know','use','using','used','get','got','one','two','new','old','same','message','response','branch','chat','conversation',
]);

function uid(prefix = 'branch'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export function branchRootId(chatId: string): string { return `branch:root:${chatId}`; }

function nodesFromPath(events: ChatEvent[], existing: BranchEventNode[] = []): BranchEventNode[] {
  const nodes = new Map(existing.map((node) => [node.event.id, node]));
  let parentId: string | null = null;
  for (const event of events) {
    const prior = nodes.get(event.id);
    nodes.set(event.id, { event, parentId: prior?.parentId ?? parentId });
    parentId = event.id;
  }
  return [...nodes.values()];
}

export function branchEventsFromState(state: BranchingState, branchId: string | null | undefined): ChatEvent[] {
  const branch = state.branches.find((item) => item.id === branchId);
  if (!branch?.headEventId) return [];
  const nodes = new Map(state.nodes.map((node) => [node.event.id, node]));
  const path: ChatEvent[] = [];
  const seen = new Set<string>();
  let cursor: string | null = branch.headEventId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = nodes.get(cursor);
    if (!node) break;
    path.push(node.event);
    cursor = node.parentId;
  }
  return path.reverse();
}

export function ensureBranching(chat: Chat): BranchingState {
  if (chat.branching?.branches?.length && Array.isArray(chat.branching.nodes)) return chat.branching;
  const rootId = branchRootId(chat.id);
  return {
    version: 1,
    currentBranchId: rootId,
    nodes: nodesFromPath(chat.events),
    branches: [{
      id: rootId,
      parentBranchId: null,
      origin: 'root',
      title: chat.title || 'Main branch',
      titleSource: 'auto',
      createdAt: new Date(chat.createdAt),
      updatedAt: new Date(chat.updatedAt),
      headEventId: chat.events.at(-1)?.id ?? null,
    }],
  };
}

export function branchById(state: BranchingState, branchId: string | null | undefined): BranchRecord | undefined {
  return state.branches.find((branch) => branch.id === branchId);
}

export function branchEvents(chat: Chat, branchId: string | null | undefined): ChatEvent[] {
  const state = ensureBranching(chat);
  return branchEventsFromState(state, branchId);
}

function words(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_+#.-]*/gu) ?? [])
    .map((word) => word.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

function textOf(event: ChatEvent | undefined): string {
  if (!event) return '';
  if ('content' in event && typeof event.content === 'string') return event.content;
  return '';
}

function candidatePhrases(text: string): string[] {
  const raw = text.replace(/\s+/g, ' ').trim();
  const tokens = raw.match(/[A-Za-z0-9][A-Za-z0-9_+#.'-]*/g) ?? [];
  const candidates: string[] = [];
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const slice = tokens.slice(i, i + n);
      const semantic = slice.filter((token) => !STOP.has(token.toLocaleLowerCase()) && token.length >= 3);
      if (semantic.length >= Math.min(2, n)) candidates.push(slice.join(' '));
    }
  }
  for (const token of tokens) if (token.length >= 4 && !STOP.has(token.toLocaleLowerCase())) candidates.push(token);
  return candidates;
}

function changedTokens(before: string, after: string): Set<string> {
  const old = new Set(words(before));
  return new Set(words(after).filter((word) => !old.has(word)));
}

export function suggestBranchTitle(origin: BranchOrigin, parentEvents: ChatEvent[], events: ChatEvent[]): string {
  const parentWords = new Set(words(parentEvents.map(textOf).join('\n')));
  const eventWords = words(events.map(textOf).join('\n'));
  const recentText = events.slice(Math.max(0, events.length - 4)).map(textOf).join(' ');
  let focusText = recentText;
  let delta = new Set<string>();
  if (origin === 'edit') {
    const editedIndex = events.findLastIndex((event) => event.type === 'user_message');
    const edited = editedIndex >= 0 ? events[editedIndex] as UserMessageEvent : undefined;
    const priorAtPosition = editedIndex >= 0 && parentEvents[editedIndex]?.type === 'user_message' ? parentEvents[editedIndex] as UserMessageEvent : undefined;
    if (edited) { focusText = edited.content; delta = changedTokens(priorAtPosition?.content ?? '', edited.content); }
  } else if (origin === 'jump') {
    const common = new Set(parentEvents.map((event) => event.id));
    const firstNew = events.find((event) => !common.has(event.id) && event.type === 'user_message');
    if (firstNew) focusText = textOf(firstNew);
  } else if (origin === 'regen') {
    const common = new Set(parentEvents.map((event) => event.id));
    const firstNewAssistant = events.find((event) => !common.has(event.id) && event.type === 'assistant_text');
    if (firstNewAssistant) focusText = textOf(firstNewAssistant);
  }

  let best = '';
  let bestScore = -Infinity;
  for (const candidate of candidatePhrases(focusText)) {
    const ws = words(candidate);
    if (!ws.length) continue;
    let score = ws.length * 1.25 + ws.filter((word) => !parentWords.has(word)).length * 2.4 + ws.filter((word) => delta.has(word)).length * 4.5;
    if (candidate.length > 42) score -= 2;
    if (ws.length === 1) score -= .75;
    if (/^[A-Z][A-Za-z0-9.+#-]+(?:\s+[A-Z][A-Za-z0-9.+#-]+)+$/.test(candidate)) score += 1.5;
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  if (!best) best = eventWords.find((word) => !parentWords.has(word)) ?? eventWords[0] ?? (origin === 'regen' ? 'alternate response' : origin === 'edit' ? 'edited path' : 'continued path');
  return best.split(/\s+/).slice(0, 5).join(' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function syncCurrentBranch(chat: Chat, events: ChatEvent[]): Chat {
  const state = ensureBranching(chat);
  const current = branchById(state, state.currentBranchId);
  if (!current) return { ...chat, events };
  const nodes = nodesFromPath(events, state.nodes);
  const nextState: BranchingState = { ...state, nodes };
  const parent = current.parentBranchId ? branchById(nextState, current.parentBranchId) : undefined;
  const parentEvents = parent ? branchEventsFromState(nextState, parent.id) : [];
  const last = events[events.length - 1];
  const stableBoundary = !last || last.type === 'user_message' || last.type === 'system_message'
    || (('status' in last) && (last.status === 'complete' || last.status === 'error' || last.status === 'interrupted'));
  nextState.branches = state.branches.map((branch) => {
    if (branch.id !== state.currentBranchId) return branch;
    const title = branch.titleSource === 'auto' && branch.origin !== 'root' && stableBoundary && parent
      ? suggestBranchTitle(branch.origin, parentEvents, events)
      : branch.title;
    return { ...branch, title, headEventId: events.at(-1)?.id ?? null, updatedAt: new Date(chat.updatedAt) };
  });
  return { ...chat, events, branching: nextState };
}

export function createBranch(chat: Chat, origin: Exclude<BranchOrigin, 'root'>, parentBranchId: string, events: ChatEvent[]): { chat: Chat; branch: BranchRecord } {
  let state = ensureBranching(chat);
  // First make sure the live branch's latest projection has been merged into the canonical event graph.
  if (state.currentBranchId === parentBranchId) state = ensureBranching(syncCurrentBranch({ ...chat, branching: state }, chat.events));
  const parent = branchById(state, parentBranchId) ?? state.branches[0];
  const nodes = nodesFromPath(events, state.nodes);
  const branch: BranchRecord = {
    id: uid(), parentBranchId: parent.id, origin,
    title: suggestBranchTitle(origin, branchEventsFromState(state, parent.id), events),
    titleSource: 'auto', createdAt: new Date(), updatedAt: new Date(), headEventId: events.at(-1)?.id ?? null,
  };
  const nextState: BranchingState = { ...state, nodes, currentBranchId: branch.id, branches: [...state.branches, branch] };
  return { chat: { ...chat, events, branching: nextState, updatedAt: new Date() }, branch };
}

export function renameBranch(chat: Chat, branchId: string, title: string): Chat {
  const trimmed = title.trim();
  if (!trimmed) return chat;
  const state = ensureBranching(chat);
  return { ...chat, branching: { ...state, branches: state.branches.map((branch) => branch.id === branchId ? { ...branch, title: trimmed, titleSource: 'user', updatedAt: new Date() } : branch) } };
}

export function orderedBranches(chat: Chat): BranchRecord[] {
  return [...ensureBranching(chat).branches].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
