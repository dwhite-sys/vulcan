import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComposerContextItem } from '../types/vulcan';
import { quoteConnectorPath, type QuoteAnchor } from '../services/quoteGeometry';
import { QUOTE_COLORS } from '../services/quoteProjection';

interface Connection {
  key: string;
  start: QuoteAnchor;
  end: QuoteAnchor;
  subdued?: boolean;
}

const quoteSourceElements = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-vulcan-quote-source-id]'));

const cardElements = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-vulcan-context-card-id], [data-vulcan-quote-card-id]'));

const inlineElements = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-context-id], [data-quote-id]'));

function safeClassToken(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function liveTargetElements(item: ComposerContextItem): HTMLElement[] {
  if (item.kind === 'quote') {
    return quoteSourceElements().filter((element) => element.dataset.vulcanQuoteSourceId === item.id);
  }
  if (item.kind === 'reference') {
    const exact = Array.from(document.querySelectorAll<HTMLElement>(`.vulcan-context-target-${safeClassToken(item.id)}`));
    if (exact.length > 0) return exact;
    return Array.from(document.querySelectorAll<HTMLElement>('[data-vulcan-workspace-file]'))
      .filter((element) => element.dataset.vulcanWorkspaceFile === item.path);
  }
  return Array.from(document.querySelectorAll<HTMLElement>('[data-vulcan-element-reference-id]'))
    .filter((element) => element.dataset.vulcanElementReferenceId === item.id);
}

function hoveredContextId(target: Element | null, x: number, y: number): string | null {
  const direct = target?.closest<HTMLElement>(
    '[data-vulcan-context-card-id], [data-vulcan-quote-card-id], [data-context-id], [data-quote-id], [data-vulcan-quote-marker-id]',
  );
  const directId = direct?.dataset.vulcanContextCardId ?? direct?.dataset.vulcanQuoteCardId ??
    direct?.dataset.contextId ?? direct?.dataset.quoteId ?? direct?.dataset.vulcanQuoteMarkerId;
  if (directId) return directId;

  if (!target) return null;
  const quoteSource = quoteSourceElements().find((element) => {
    if (!element.closest('[data-vulcan-message-id]')?.contains(target)) return false;
    const bounds = element.getBoundingClientRect();
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  });
  return quoteSource?.dataset.vulcanQuoteSourceId ?? null;
}

/**
 * Shared source-link overlay for composer context. A quote can resolve to the
 * transcript, a file reference to a live Monaco decoration/editor, and a
 * Design element to a future DOM target. Missing live targets simply draw no
 * source connector; the context item remains valid.
 */
export function ContextConnections({ items }: { items: ComposerContextItem[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const follow = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      let id = hoveredContextId(target, event.clientX, event.clientY);
      if (id && !itemsRef.current.some((item) => item.id === id)) id = null;
      setActiveId((current) => current === id ? current : id);
    };
    const clear = () => setActiveId(null);
    window.addEventListener('pointermove', follow, { passive: true });
    document.addEventListener('mouseleave', clear);
    return () => {
      window.removeEventListener('pointermove', follow);
      document.removeEventListener('mouseleave', clear);
    };
  }, []);

  useEffect(() => {
    const item = items.find((candidate) => candidate.id === activeId);
    if (!activeId || !item) {
      setConnections([]);
      return;
    }

    let frame = 0;
    const measure = () => {
      const card = cardElements().find((element) =>
        (element.dataset.vulcanContextCardId ?? element.dataset.vulcanQuoteCardId) === activeId);
      if (!card) {
        setConnections([]);
        return;
      }
      const cardBounds = card.getBoundingClientRect();
      const top = { x: cardBounds.left + cardBounds.width / 2, y: cardBounds.top + 2 };
      const bottom = { x: cardBounds.left + cardBounds.width / 2, y: cardBounds.bottom - 2 };
      const next: Connection[] = [];

      const targets = liveTargetElements(item);
      const source = targets[targets.length - 1];
      if (source) {
        const bounds = source.getBoundingClientRect();
        const viewport = source.closest<HTMLElement>('.overflow-y-auto')?.getBoundingClientRect();
        if (!viewport || bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
          next.push({
            key: `source:${activeId}`,
            start: top,
            end: { x: bounds.left + bounds.width / 2, y: bounds.bottom - 2 },
            subdued: true,
          });
        }
      }

      inlineElements()
        .filter((element) => (element.dataset.contextId ?? element.dataset.quoteId) === activeId)
        .forEach((reference, index) => {
          const bounds = reference.getBoundingClientRect();
          next.push({
            key: `inline:${activeId}:${index}`,
            start: { x: bounds.left + bounds.width / 2, y: bounds.top + 2 },
            end: bottom,
          });
        });
      setConnections(next);
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const linked = [
      ...liveTargetElements(item),
      ...cardElements().filter((element) =>
        (element.dataset.vulcanContextCardId ?? element.dataset.vulcanQuoteCardId) === activeId),
      ...inlineElements().filter((element) =>
        (element.dataset.contextId ?? element.dataset.quoteId) === activeId),
      ...Array.from(document.querySelectorAll<HTMLElement>('[data-vulcan-quote-marker-id]'))
        .filter((element) => element.dataset.vulcanQuoteMarkerId === activeId),
    ];
    linked.forEach((element) => element.classList.add('vulcan-context-linked', 'vulcan-quote-linked'));
    schedule();
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    observer?.observe(document.body, { childList: true, subtree: true, attributes: true });

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      linked.forEach((element) => element.classList.remove('vulcan-context-linked', 'vulcan-quote-linked'));
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
    };
  }, [activeId, items]);

  if (!activeId || connections.length === 0) return null;
  const index = items.findIndex((item) => item.id === activeId);
  if (index < 0) return null;
  const color = QUOTE_COLORS[index % QUOTE_COLORS.length];

  return createPortal(
    <svg className="vulcan-quote-connections vulcan-context-connections" aria-hidden="true">
      {connections.map((connection) => (
        <g key={connection.key} style={{ '--quote-color': color } as React.CSSProperties}>
          <path
            className={`vulcan-quote-connection${connection.subdued ? ' vulcan-quote-connection-subdued' : ''}`}
            d={quoteConnectorPath(connection.start, connection.end)}
          />
          <circle className="vulcan-quote-connection-endpoint" cx={connection.start.x} cy={connection.start.y} r="2.4" />
          <circle className="vulcan-quote-connection-endpoint" cx={connection.end.x} cy={connection.end.y} r="2.4" />
        </g>
      ))}
    </svg>,
    document.body,
  );
}
