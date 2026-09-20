import type { ComposerContextItem, Message, MessageElementReference, MessageFileReference, MessageQuote } from '../types/vulcan.ts';

export function messageContextItems(message: Pick<Message, 'quotes' | 'references' | 'elements' | 'contextOrder'>): ComposerContextItem[] {
  const all: ComposerContextItem[] = [
    ...(message.quotes ?? []).map((item) => ({ ...item, kind: 'quote' as const })),
    ...(message.references ?? []).map((item) => ({ ...item, kind: 'reference' as const })),
    ...(message.elements ?? []).map((item) => ({ ...item, kind: 'element' as const })),
  ];
  if (!message.contextOrder?.length) return all;
  const byId = new Map(all.map((item) => [item.id, item]));
  const ordered = message.contextOrder.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []);
  const seen = new Set(ordered.map((item) => item.id));
  return [...ordered, ...all.filter((item) => !seen.has(item.id))];
}

export function splitComposerContext(items: ComposerContextItem[]): {
  quotes?: MessageQuote[];
  references?: MessageFileReference[];
  elements?: MessageElementReference[];
  contextOrder?: string[];
} {
  const quotes = items.filter((item): item is MessageQuote & { kind: 'quote' } => item.kind === 'quote').map(({ kind: _kind, ...item }) => item);
  const references = items.filter((item): item is MessageFileReference & { kind: 'reference' } => item.kind === 'reference').map(({ kind: _kind, ...item }) => item);
  const elements = items.filter((item): item is MessageElementReference & { kind: 'element' } => item.kind === 'element').map(({ kind: _kind, ...item }) => item);
  return {
    ...(quotes.length ? { quotes } : {}),
    ...(references.length ? { references } : {}),
    ...(elements.length ? { elements } : {}),
    ...(items.length ? { contextOrder: items.map((item) => item.id) } : {}),
  };
}


export function mergeEditedAttachments(retained: import('../types/vulcan.ts').MessageAttachment[] = [], added: import('../types/vulcan.ts').MessageAttachment[] = []) {
  return [...retained, ...added];
}
