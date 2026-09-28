export interface QuoteTextRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface QuoteAnchor {
  x: number;
  y: number;
}

export interface QuoteSourceMark {
  id: string;
  offset: number;
  number: number;
  color: string;
}

export interface QuoteMarkupNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: QuoteMarkupNode[];
}

/** Insert source numbers into the rendered Markdown tree, never over its text. */
export function insertQuoteSourceMarks(tree: QuoteMarkupNode, marks: QuoteSourceMark[]): void {
  const pending = [...marks]
    .filter((mark) => Number.isSafeInteger(mark.offset) && mark.offset >= 0)
    .sort((first, second) => first.offset - second.offset || first.number - second.number);
  let cursor = 0;
  let next = 0;

  const visit = (parent: QuoteMarkupNode): void => {
    if (!parent.children || next >= pending.length) return;

    for (let index = 0; index < parent.children.length && next < pending.length; index++) {
      const child = parent.children[index];
      if (child.type !== 'text') {
        visit(child);
        continue;
      }

      const value = child.value ?? '';
      const end = cursor + value.length;
      if (pending[next].offset > end) {
        cursor = end;
        continue;
      }

      const replacement: QuoteMarkupNode[] = [];
      let consumed = 0;
      while (next < pending.length && pending[next].offset <= end) {
        const mark = pending[next];
        if (mark.offset < cursor) {
          next++;
          continue;
        }
        const cut = mark.offset - cursor;
        if (cut > consumed) replacement.push({ type: 'text', value: value.slice(consumed, cut) });
        replacement.push({
          type: 'element',
          tagName: 'sup',
          properties: {
            className: ['vulcan-source-quote-number'],
            'data-vulcan-quote-marker-id': mark.id,
            style: `--quote-color: ${mark.color}`,
          },
          children: [{ type: 'text', value: String(mark.number) }],
        });
        consumed = cut;
        next++;
      }
      if (consumed < value.length) replacement.push({ type: 'text', value: value.slice(consumed) });
      parent.children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
      cursor = end;
    }
  };

  visit(tree);
}

/** Route between quote surfaces with a calm vertical cubic curve. */
export function quoteConnectorPath(start: QuoteAnchor, end: QuoteAnchor): string {
  const bend = Math.max(28, Math.min(130, Math.abs(end.y - start.y) * 0.46));
  const direction = end.y >= start.y ? 1 : -1;
  return `M ${start.x} ${start.y} C ${start.x} ${start.y + bend * direction}, ` +
    `${end.x} ${end.y - bend * direction}, ${end.x} ${end.y}`;
}

/** Join neighboring text runs without ever including their Markdown container. */
export function mergeQuoteTextRects(rectangles: QuoteTextRect[]): QuoteTextRect[] {
  const sorted = [...rectangles].sort((first, second) => {
    const firstCenter = (first.top + first.bottom) / 2;
    const secondCenter = (second.top + second.bottom) / 2;
    return Math.abs(firstCenter - secondCenter) <= 3
      ? first.left - second.left
      : firstCenter - secondCenter;
  });
  const merged: QuoteTextRect[] = [];

  for (const rectangle of sorted) {
    const previous = merged[merged.length - 1];
    const sameLine = previous && Math.abs(
      (previous.top + previous.bottom) / 2 -
      (rectangle.top + rectangle.bottom) / 2,
    ) <= 3;

    if (sameLine && rectangle.left <= previous.right + 6) {
      previous.left = Math.min(previous.left, rectangle.left);
      previous.top = Math.min(previous.top, rectangle.top);
      previous.right = Math.max(previous.right, rectangle.right);
      previous.bottom = Math.max(previous.bottom, rectangle.bottom);
      previous.width = previous.right - previous.left;
      previous.height = previous.bottom - previous.top;
      continue;
    }

    merged.push({ ...rectangle });
  }

  return merged;
}
