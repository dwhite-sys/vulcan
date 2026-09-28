import type { ChatEvent } from '../types/vulcan';
import type { TranscriptSearchHitDescriptor } from './vulcan';
import { buildTranscriptBlocks } from './transcript.ts';

export interface TranscriptSearchMatch {
  id: string;
  blockIndex: number;
  eventId: string;
  eventType: ChatEvent['type'];
  start: number;
  end: number;
  occurrence: number;
  preview?: string;
  timestamp?: string;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value ?? ''); } catch { return String(value ?? ''); }
}

export function transcriptEventSearchText(event: ChatEvent): string {
  switch (event.type) {
    case 'user_message':
    case 'system_message':
    case 'assistant_text':
    case 'reasoning':
      return event.content ?? '';
    case 'tool':
      return [event.tool, safeJson(event.arguments), safeJson(event.result)].filter(Boolean).join('\n');
    case 'presented_file':
      return [event.file?.name, event.file?.path].filter(Boolean).join('\n');
    case 'panel':
      return event.panel?.name ?? '';
    default:
      return '';
  }
}

export function searchTranscript(events: ChatEvent[], query: string): TranscriptSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const matches: TranscriptSearchMatch[] = [];
  const blocks = buildTranscriptBlocks(events);
  blocks.forEach((block, blockIndex) => {
    const blockEvents: ChatEvent[] = block.kind === 'single' ? [block.event] : block.events;
    for (const event of blockEvents) {
      const text = transcriptEventSearchText(event);
      const haystack = text.toLocaleLowerCase();
      let from = 0;
      let occurrence = 0;
      while (from <= haystack.length - needle.length) {
        const start = haystack.indexOf(needle, from);
        if (start < 0) break;
        matches.push({
          id: `${event.id}:${start}:${needle.length}`,
          blockIndex,
          eventId: event.id,
          eventType: event.type,
          start,
          end: start + needle.length,
          occurrence,
        });
        occurrence += 1;
        from = start + Math.max(needle.length, 1);
      }
    }
  });
  return matches;
}

export function firstSearchMatchPerEvent(matches: readonly TranscriptSearchMatch[]): TranscriptSearchMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    if (seen.has(match.eventId)) return false;
    seen.add(match.eventId);
    return true;
  });
}

export function clampSearchIndex(index: number | undefined, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index ?? 0, 0), count - 1);
}

export function advanceSearchIndex(index: number | undefined, count: number, delta: number): number {
  if (count <= 0) return 0;
  const current = clampSearchIndex(index, count);
  return (current + delta + count) % count;
}

export function advanceSearchChatId(chatIds: readonly string[], currentChatId: string | null | undefined, delta: number): string | null {
  if (!chatIds.length) return null;
  const currentIndex = currentChatId ? chatIds.indexOf(currentChatId) : -1;
  const base = currentIndex >= 0 ? currentIndex : (delta > 0 ? -1 : 0);
  return chatIds[(base + delta + chatIds.length) % chatIds.length] ?? null;
}

export function unhydratedTranscriptSearchMatches(
  hits: readonly TranscriptSearchHitDescriptor[],
): TranscriptSearchMatch[] {
  return hits.map((hit, index) => ({
    id: `${hit.event_id}:preview:${index}`,
    blockIndex: -1,
    eventId: hit.event_id,
    eventType: hit.event_type as ChatEvent['type'],
    start: hit.start ?? 0,
    end: hit.end ?? 0,
    occurrence: hit.occurrence ?? 0,
    preview: hit.message ?? '',
    timestamp: hit.timestamp,
  }));
}

export function transcriptSearchDescriptors(
  matches: readonly TranscriptSearchMatch[],
): TranscriptSearchHitDescriptor[] {
  return matches.map((match) => ({
    event_id: match.eventId,
    event_type: match.eventType,
    start: match.start,
    end: match.end,
    occurrence: match.occurrence,
    message: match.preview,
    timestamp: match.timestamp,
  }));
}

export function hydrateTranscriptSearchMatches(
  events: ChatEvent[],
  hits: readonly TranscriptSearchHitDescriptor[],
): TranscriptSearchMatch[] {
  if (!hits.length) return [];
  const blockByEventId = new Map<string, number>();
  buildTranscriptBlocks(events).forEach((block, blockIndex) => {
    const blockEvents: ChatEvent[] = block.kind === 'single' ? [block.event] : block.events;
    blockEvents.forEach((event) => blockByEventId.set(event.id, blockIndex));
  });
  return hits.flatMap((hit) => {
    const blockIndex = blockByEventId.get(hit.event_id);
    if (blockIndex === undefined) return [];
    return [{
      id: `${hit.event_id}:${hit.start}:${Math.max(hit.end - hit.start, 0)}`,
      blockIndex,
      eventId: hit.event_id,
      eventType: hit.event_type as ChatEvent['type'],
      start: hit.start,
      end: hit.end,
      occurrence: hit.occurrence,
    }];
  });
}
