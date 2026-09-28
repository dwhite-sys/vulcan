import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { MessageQuote } from '../types/vulcan';
import { mergeQuoteTextRects, type QuoteSourceMark, type QuoteTextRect } from '../services/quoteGeometry';
import { QUOTE_COLORS } from '../services/quoteProjection';

interface QuoteRect {
  key: string;
  quoteId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  number: number;
  color: string;
}

/** Keep source marks inside React-managed Markdown and highlights as separate overlays. */
export function QuoteSource({ messageId, role, quotes = [], contextOrder = [], content, children }: {
  messageId: string;
  role: 'user' | 'assistant';
  quotes?: MessageQuote[];
  contextOrder?: string[];
  content: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<QuoteRect[]>([]);
  const sourceMarks: QuoteSourceMark[] = quotes
    .filter((quote) => quote.messageId === messageId)
    .map((quote, index) => {
      const displayIndex = contextOrder.length ? contextOrder.indexOf(quote.id) : index;
      return {
        id: quote.id,
        offset: quote.end,
        number: displayIndex + 1,
        color: QUOTE_COLORS[displayIndex % QUOTE_COLORS.length],
      };
    })
    .filter((mark) => mark.number > 0);

  useEffect(() => {
    const root = rootRef.current;
    const body = contentRef.current;
    if (!root || !body) return;
    if (!quotes.some((quote) => quote.messageId === messageId)) {
      setRects((current) => current.length ? [] : current);
      return;
    }
    let frame = 0;
    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const next: QuoteRect[] = [];
      quotes.forEach((quote, index) => {
        if (quote.messageId !== messageId) return;
        const displayIndex = contextOrder.length ? contextOrder.indexOf(quote.id) : index;
        if (displayIndex < 0) return;
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
          acceptNode: (candidate) => candidate.parentElement?.closest('[data-vulcan-quote-marker-id]')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
        });
        let cursor = 0;
        const textRects: QuoteTextRect[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const value = node.textContent ?? '';
          const size = value.length;
          let start = Math.max(0, quote.start - cursor);
          let end = Math.min(size, quote.end - cursor);
          cursor += size;

          if (start >= end || !value.slice(start, end).trim()) {
            if (cursor >= quote.end) break;
            continue;
          }

          while (start < end && /\s/u.test(value[start])) start++;
          while (end > start && /\s/u.test(value[end - 1])) end--;

          try {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, end);
            for (const rectangle of range.getClientRects()) {
              if (rectangle.width > 0 && rectangle.height > 0) {
                textRects.push({
                  left: rectangle.left,
                  top: rectangle.top,
                  right: rectangle.right,
                  bottom: rectangle.bottom,
                  width: rectangle.width,
                  height: rectangle.height,
                });
              }
            }
          } catch {
            // A streaming source may momentarily replace its Markdown text.
          }

          if (cursor >= quote.end) break;
        }

        const pieces = mergeQuoteTextRects(textRects);
        const marker = Array.from(body.querySelectorAll<HTMLElement>('[data-vulcan-quote-marker-id]'))
          .find((candidate) => candidate.dataset.vulcanQuoteMarkerId === quote.id);
        const finalPiece = pieces[pieces.length - 1];
        if (marker && finalPiece) {
          const mark = marker.getBoundingClientRect();
          const sameLine = mark.bottom > finalPiece.top && mark.top < finalPiece.bottom;
          if (sameLine && mark.left >= finalPiece.right - 1 && mark.left <= finalPiece.right + 4) {
            finalPiece.right = Math.max(finalPiece.right, mark.right);
            finalPiece.width = finalPiece.right - finalPiece.left;
          }
        }
        pieces.forEach((piece, pieceIndex) => next.push({
          key: `${quote.id}:${pieceIndex}`,
          quoteId: quote.id,
          left: piece.left - bounds.left,
          top: piece.top - bounds.top,
          width: piece.width,
          height: piece.height,
          number: displayIndex + 1,
          color: QUOTE_COLORS[displayIndex % QUOTE_COLORS.length],
        }));
      });
      setRects(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    schedule();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(body);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [content, contextOrder, messageId, quotes]);

  return (
    <div ref={rootRef} className="vulcan-quotable-content" data-vulcan-message-id={messageId} data-vulcan-message-role={role}>
      <div ref={contentRef} data-vulcan-quote-body="true">
        {isValidElement(children)
          ? cloneElement(children as ReactElement<{ sourceMarks?: QuoteSourceMark[] }>, { sourceMarks })
          : children}
      </div>
      {rects.map((rect) => (
        <span key={rect.key} className="vulcan-source-quote-highlight" data-vulcan-quote-source-id={rect.quoteId} style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          '--quote-color': rect.color,
        } as React.CSSProperties} />
      ))}
    </div>
  );
}
