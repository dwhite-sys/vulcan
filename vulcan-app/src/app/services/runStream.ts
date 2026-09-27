/**
 * runStream.ts — live run transcript application (renderer side).
 *
 * The server streams a run as:
 *   push/run-event   authoritative snapshot of ONE event (created, finalized,
 *                    tool result, replacement for a lagging client), with the
 *                    event's stream `seq` at snapshot time;
 *   push/run-delta   ordered append-only delta for one live event (`seq` is
 *                    contiguous per event: 1, 2, 3, ...);
 *   push/run-events  full transcript snapshot at run end / resync, with seqs.
 *
 * Rules (mirrored by the server tests):
 *   - a snapshot with seq >= known replaces the event and sets known = seq;
 *   - a delta applies only when seq === known + 1 (then known = seq);
 *   - a delta with seq <= known is already contained in a snapshot: ignore;
 *   - a delta for an unknown event or with seq > known + 1 is a gap: the
 *     caller should request one resubscription (full reconciliation).
 *
 * A token delta is a pure transcript edit. It never touches branch topology,
 * sidebar data or any other chat projection.
 */

import type { ChatEvent } from '../types/vulcan';

export type EventSeqs = Map<string, number>;

/**
 * Known seqs are attached to the identity of the events array they describe.
 * Each transcript representation (active chat, pending chat, sidebar entry)
 * therefore carries its own bookkeeping, and applying a batch is a pure
 * function of (events array, batch) — safe inside React state updaters, which
 * React may invoke more than once.
 */
const SEQS = new WeakMap<ChatEvent[], EventSeqs>();

export function seqsOf(events: ChatEvent[]): EventSeqs {
  return SEQS.get(events) ?? new Map();
}

export function attachSeqs(events: ChatEvent[], seqs: Record<string, number> | EventSeqs | null | undefined): ChatEvent[] {
  const map = seqs instanceof Map
    ? new Map(seqs)
    : new Map(Object.entries(seqs ?? {}).map(([eventId, seq]) => [eventId, Number(seq)] as [string, number]));
  SEQS.set(events, map);
  return events;
}

export interface RunDeltaPayload {
  chat_id: string;
  run_id?: string;
  event_id: string;
  seq: number;
  append?: Record<string, string>;
  extend?: Record<string, unknown[]>;
  set?: Record<string, unknown>;
}

export interface RunEventPayload {
  chat_id: string;
  event: any;
  seq?: number;
}

export type ApplyOutcome = 'applied' | 'stale' | 'gap';

/** Index of an event, scanning from the end (live events are near the tail). */
export function findEventIndex(events: ChatEvent[], eventId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].id === eventId) return index;
  }
  return -1;
}

/**
 * Apply one ordered delta. Returns the same array (identity) unless applied,
 * so callers can skip React updates for stale/gapped deltas.
 */
export function applyRunDelta(
  events: ChatEvent[],
  seqs: EventSeqs,
  payload: RunDeltaPayload,
): { events: ChatEvent[]; outcome: ApplyOutcome } {
  const seq = Number(payload.seq);
  const known = seqs.get(payload.event_id);
  if (known !== undefined && seq <= known) return { events, outcome: 'stale' };
  const index = findEventIndex(events, payload.event_id);
  if (known === undefined || index < 0 || seq !== known + 1) return { events, outcome: 'gap' };
  const current = events[index] as any;
  const next: any = { ...current };
  for (const [name, text] of Object.entries(payload.append ?? {})) {
    next[name] = `${typeof current[name] === 'string' ? current[name] : ''}${text}`;
  }
  for (const [name, items] of Object.entries(payload.extend ?? {})) {
    next[name] = [...(Array.isArray(current[name]) ? current[name] : []), ...items];
  }
  Object.assign(next, payload.set ?? {});
  const updated = events.slice();
  updated[index] = next as ChatEvent;
  seqs.set(payload.event_id, seq);
  return { events: updated, outcome: 'applied' };
}

/**
 * Upsert one authoritative event snapshot (respecting seq monotonicity).
 * `payload.event` must already be rehydrated (Dates etc.) by the caller.
 */
export function applyRunEventSnapshot(
  events: ChatEvent[],
  seqs: EventSeqs,
  payload: RunEventPayload,
): { events: ChatEvent[]; outcome: ApplyOutcome } {
  const event = payload.event as ChatEvent | undefined;
  if (!event?.id) return { events, outcome: 'stale' };
  const seq = Number(payload.seq ?? 0);
  const known = seqs.get(event.id);
  // Pre-seq servers omit `seq`; their snapshots are always authoritative.
  if (payload.seq !== undefined && known !== undefined && seq < known) return { events, outcome: 'stale' };
  seqs.set(event.id, seq);
  const index = findEventIndex(events, event.id);
  if (index < 0) return { events: [...events, event], outcome: 'applied' };
  const updated = events.slice();
  updated[index] = event;
  return { events: updated, outcome: 'applied' };
}

/** Reset a chat's known seqs from a full snapshot (run-events / subscribe). */
export function resetSeqs(seqs: EventSeqs, snapshotSeqs: Record<string, number> | undefined | null): void {
  seqs.clear();
  for (const [eventId, seq] of Object.entries(snapshotSeqs ?? {})) seqs.set(eventId, Number(seq));
}

export type RunStreamMessage =
  | { kind: 'delta'; payload: RunDeltaPayload }
  | { kind: 'event'; payload: RunEventPayload }
  | { kind: 'full'; events: ChatEvent[]; seqs?: Record<string, number> | null; updatedAt?: string };

/**
 * Apply queued stream messages (arrival order) to one events array.
 * Pure: returns a new array (with its own attached seqs) only when something
 * changed. `gap` reports a delta that could not be applied, meaning this
 * representation must be reconciled from a full snapshot.
 */
export function applyRunStreamBatch(
  events: ChatEvent[],
  batch: RunStreamMessage[],
): { events: ChatEvent[]; changed: boolean; gap: boolean; full: boolean } {
  const seqs = new Map(seqsOf(events));
  // Copy-on-write: at most one array copy per batch (per frame), however many
  // deltas it contains; each delta is then an O(1) index update + append.
  let working: ChatEvent[] | null = null;
  let current = events;
  const writable = (): ChatEvent[] => {
    if (working === null) { working = current.slice(); current = working; }
    return working;
  };
  const positions = new Map<string, number>();
  const indexOf = (eventId: string): number => {
    const cached = positions.get(eventId);
    if (cached !== undefined && current[cached]?.id === eventId) return cached;
    const found = findEventIndex(current, eventId);
    if (found >= 0) positions.set(eventId, found);
    return found;
  };
  let gap = false;
  let full = false;
  for (const message of batch) {
    if (message.kind === 'full') {
      working = message.events.slice();
      current = working;
      positions.clear();
      resetSeqs(seqs, message.seqs);
      gap = false;
      full = true;
      continue;
    }
    if (message.kind === 'delta') {
      const payload = message.payload;
      const seq = Number(payload.seq);
      const known = seqs.get(payload.event_id);
      if (known !== undefined && seq <= known) continue;
      const index = indexOf(payload.event_id);
      if (known === undefined || index < 0 || seq !== known + 1) { gap = true; continue; }
      const target = writable();
      const existing = target[index] as any;
      const next: any = { ...existing };
      for (const [name, text] of Object.entries(payload.append ?? {})) {
        next[name] = `${typeof existing[name] === 'string' ? existing[name] : ''}${text}`;
      }
      for (const [name, items] of Object.entries(payload.extend ?? {})) {
        next[name] = [...(Array.isArray(existing[name]) ? existing[name] : []), ...items];
      }
      Object.assign(next, payload.set ?? {});
      target[index] = next as ChatEvent;
      seqs.set(payload.event_id, seq);
      continue;
    }
    const event = message.payload.event as ChatEvent | undefined;
    if (!event?.id) continue;
    const seq = Number(message.payload.seq ?? 0);
    const known = seqs.get(event.id);
    if (message.payload.seq !== undefined && known !== undefined && seq < known) continue;
    seqs.set(event.id, seq);
    const index = indexOf(event.id);
    const target = writable();
    if (index < 0) {
      target.push(event);
      positions.set(event.id, target.length - 1);
    } else {
      target[index] = event;
    }
  }
  if (current !== events) SEQS.set(current, seqs);
  return { events: current, changed: current !== events, gap, full };
}
