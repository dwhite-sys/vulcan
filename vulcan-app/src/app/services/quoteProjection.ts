import type { MessageElementReference, MessageFileReference, MessageQuote } from '../types/vulcan.ts';

export const QUOTE_TOKEN_PREFIX = '\uE000vulcan-quote:';
export const REFERENCE_TOKEN_PREFIX = '\uE000vulcan-reference:';
export const ELEMENT_TOKEN_PREFIX = '\uE000vulcan-element:';
export const QUOTE_TOKEN_SUFFIX = '\uE001';
export const QUOTE_COLORS = ['#ed7884', '#a996f4', '#71b8a9', '#e6b76c', '#82aaf1', '#d58ed7'];

function contextPattern(): RegExp {
  return /\uE000vulcan-(quote|reference|element):([a-zA-Z0-9_-]+)\uE001/g;
}

export function quoteReferenceToken(id: string): string {
  return `${QUOTE_TOKEN_PREFIX}${id}${QUOTE_TOKEN_SUFFIX}`;
}

export function fileReferenceToken(id: string): string {
  return `${REFERENCE_TOKEN_PREFIX}${id}${QUOTE_TOKEN_SUFFIX}`;
}

export function elementReferenceToken(id: string): string {
  return `${ELEMENT_TOKEN_PREFIX}${id}${QUOTE_TOKEN_SUFFIX}`;
}

export function escapeQuoteXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeQuoteXml(value).replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}


function elementXml(element: MessageElementReference, number: number): string {
  const attributes = [
    `id="${number}"`,
    `design="${escapeAttribute(element.designId)}"`,
    `locator="${escapeAttribute(element.locator)}"`,
    `hierarchy="${escapeAttribute(element.hierarchyAddress)}"`,
    `tag="${escapeAttribute(element.tagName)}"`,
  ];
  if (element.text) attributes.push(`text="${escapeAttribute(element.text)}"`);
  if (element.route) attributes.push(`route="${escapeAttribute(element.route)}"`);
  return `<element ${attributes.join(' ')}></element>`;
}

function referenceXml(reference: MessageFileReference, number: number): string {
  const attributes = [`id="${number}"`, `path="${escapeAttribute(reference.path)}"`];
  if (Number.isSafeInteger(reference.startLine) && Number(reference.startLine) > 0) {
    attributes.push(`start_line="${reference.startLine}"`);
    if (Number.isSafeInteger(reference.endLine) && Number(reference.endLine) >= Number(reference.startLine)) {
      attributes.push(`end_line="${reference.endLine}"`);
    }
  }
  if (reference.revision) attributes.push(`revision="${escapeAttribute(reference.revision)}"`);
  return `<reference ${attributes.join(' ')}></reference>`;
}

export function projectQuotedContent(
  content: string,
  quotes: MessageQuote[] = [],
  references: MessageFileReference[] = [],
  contextOrder: string[] = [],
  elements: MessageElementReference[] = [],
): string {
  if (quotes.length === 0 && references.length === 0 && elements.length === 0) return content;
  const order = contextOrder.length ? contextOrder : [
    ...quotes.map((quote) => quote.id),
    ...references.map((reference) => reference.id),
    ...elements.map((element) => element.id),
  ];
  const numbers = new Map(order.map((id, index) => [id, index + 1]));
  const quoteById = new Map(quotes.map((quote) => [quote.id, quote]));
  const referenceById = new Map(references.map((reference) => [reference.id, reference]));
  const elementById = new Map(elements.map((element) => [element.id, element]));
  const placed = new Set<string>();
  const message = content.replace(contextPattern(), (_match, kind: string, id: string) => {
    const number = numbers.get(id);
    if (!number) return '';
    if (kind === 'quote') {
      const quote = quoteById.get(id);
      if (!quote) return '';
      placed.add(id);
      return `<quote id="${number}">${escapeQuoteXml(quote.text)}</quote>`;
    }
    if (kind === 'reference') {
      const reference = referenceById.get(id);
      if (!reference) return '';
      placed.add(id);
      return referenceXml(reference, number);
    }
    const element = elementById.get(id);
    if (!element) return '';
    placed.add(id);
    return elementXml(element, number);
  });
  const unplacedQuotes = order.flatMap((id) => {
    const quote = quoteById.get(id);
    return quote && !placed.has(id) ? [`  <quote id="${numbers.get(id)}">${escapeQuoteXml(quote.text)}</quote>`] : [];
  });
  const unplacedReferences = order.flatMap((id) => {
    const reference = referenceById.get(id);
    return reference && !placed.has(id) ? [`  ${referenceXml(reference, numbers.get(id)!)}`] : [];
  });
  const unplacedElements = order.flatMap((id) => {
    const element = elementById.get(id);
    return element && !placed.has(id) ? [`  ${elementXml(element, numbers.get(id)!)}`] : [];
  });
  const context = [
    ...(unplacedQuotes.length ? [`<quotes>\n${unplacedQuotes.join('\n')}\n</quotes>`] : []),
    ...(unplacedReferences.length ? [`<references>\n${unplacedReferences.join('\n')}\n</references>`] : []),
    ...(unplacedElements.length ? [`<elements>\n${unplacedElements.join('\n')}\n</elements>`] : []),
  ].join('\n\n');
  return context && message ? `${context}\n\n${message}` : context || message;
}

export function stripContextTokens(content: string): string {
  return content.replace(contextPattern(), '');
}

export function displayQuotedContent(
  content: string,
  quotes: MessageQuote[] = [],
  references: MessageFileReference[] = [],
  contextOrder: string[] = [],
  elements: MessageElementReference[] = [],
): string {
  const superscripts = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
  const order = contextOrder.length ? contextOrder : [...quotes.map((quote) => quote.id), ...references.map((reference) => reference.id), ...elements.map((element) => element.id)];
  const indices = new Map(order.map((id, index) => [id, index + 1]));
  return content.replace(contextPattern(), (_match, _kind: string, id: string) => {
    const number = indices.get(id);
    return number === undefined ? '' : Array.from(String(number), (digit) => superscripts[Number(digit)]).join('');
  });
}

export const stripQuoteReferenceTokens = stripContextTokens;
