import { forwardRef, useEffect, useImperativeHandle, useRef, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { FileCode, MousePointer2, X } from 'lucide-react';
import type { ComposerContextItem } from '../types/vulcan';
import { QUOTE_COLORS, elementReferenceToken, fileReferenceToken, quoteReferenceToken } from '../services/quoteProjection';

const QUOTE_DRAG_TYPE = 'application/x-vulcan-quote';

export interface QuoteComposerHandle {
  insertReference(item: ComposerContextItem, number: number): void;
  removeReferences(quoteId: string): void;
  focus(): void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  items: ComposerContextItem[];
  onRemoveItem: (id: string) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onSubmit: () => void;
  disabled?: boolean;
  onFocus?: () => void;
}

function serializeInlineCode(contents: string): string {
  const longest = (contents.match(/`+/g) ?? []).reduce((maximum, run) => Math.max(maximum, run.length), 0);
  const delimiter = '`'.repeat(longest + 1);
  const padding = contents.startsWith('`') || contents.endsWith('`') ||
    (contents.startsWith(' ') && contents.endsWith(' ') && /[^ ]/.test(contents)) ? ' ' : '';
  return `${delimiter}${padding}${contents}${padding}${delimiter}`;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement)) return '';
  const contextId = node.dataset.contextId ?? node.dataset.quoteId;
  if (contextId) {
    if (node.dataset.contextKind === 'reference') return fileReferenceToken(contextId);
    if (node.dataset.contextKind === 'element') return elementReferenceToken(contextId);
    return quoteReferenceToken(contextId);
  }
  if (node.tagName === 'BR') return '\n';
  if (node.tagName === 'PRE') {
    const contents = node.textContent ?? '';
    const longest = (contents.match(/`+/g) ?? []).reduce((maximum, run) => Math.max(maximum, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `\n${fence}${node.dataset.language ?? ''}\n${contents.replace(/\n$/, '')}\n${fence}\n`;
  }
  const contents = Array.from(node.childNodes, serializeNode).join('');
  if (node.tagName === 'STRONG' || node.tagName === 'B') return `**${contents}**`;
  if (node.tagName === 'EM' || node.tagName === 'I') return `*${contents}*`;
  if (node.tagName === 'CODE') return serializeInlineCode(contents);
  if (node.tagName === 'A') return `[${contents}](${node.getAttribute('href') ?? ''})`;
  if (node.tagName === 'DIV' || node.tagName === 'P') return `\n${contents}`;
  return contents;
}

function caretRangeAtPoint(editor: HTMLElement, x: number, y: number): Range | null {
  const browser = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (browser.caretPositionFromPoint) {
    const point = browser.caretPositionFromPoint(x, y);
    if (!point || !editor.contains(point.offsetNode)) return null;
    const range = document.createRange();
    range.setStart(point.offsetNode, point.offset);
    range.collapse(true);
    return range;
  }
  const range = browser.caretRangeFromPoint?.(x, y) ?? null;
  return range && editor.contains(range.startContainer) ? range : null;
}

export const QuoteComposer = forwardRef<QuoteComposerHandle, Props>(function QuoteComposer({
  value, onChange, items, onRemoveItem, onPaste, onSubmit, disabled, onFocus,
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastRangeRef = useRef<Range | null>(null);
  const ownValueRef = useRef('');
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const serialize = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const next = Array.from(editor.childNodes, serializeNode).join('');
    ownValueRef.current = next;
    onChange(next);
  };

  const rememberSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (editor && selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      lastRangeRef.current = selection.getRangeAt(0).cloneRange();
    }
  };

  const activateRange = (range: Range) => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    lastRangeRef.current = range.cloneRange();
  };

  const makeReference = (item: ComposerContextItem, number: number): HTMLSpanElement => {
    const node = document.createElement('span');
    node.className = 'vulcan-quote-reference';
    node.dataset.contextId = item.id;
    node.dataset.quoteId = item.id; // compatibility with existing sent-message markup
    node.dataset.contextKind = item.kind;
    node.dataset.referenceId = `ref-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    node.style.setProperty('--quote-color', QUOTE_COLORS[(number - 1) % QUOTE_COLORS.length]);
    node.contentEditable = 'false';
    node.draggable = true;
    node.textContent = String(number);
    node.title = `${item.kind === 'reference' ? 'File reference' : item.kind === 'element' ? 'Element reference' : 'Quote'} ${number} — drag to move or drag outside to remove`;
    node.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(QUOTE_DRAG_TYPE, JSON.stringify({ id: item.id, referenceId: node.dataset.referenceId, origin: 'inline' }));
      node.classList.add('vulcan-quote-reference-dragging');
    });
    node.addEventListener('dragend', (event) => {
      node.classList.remove('vulcan-quote-reference-dragging');
      if (event.dataTransfer?.dropEffect === 'none') {
        node.remove();
        serialize();
      }
    });
    return node;
  };

  const insertAt = (item: ComposerContextItem, number: number, supplied?: Range | null, existing?: HTMLElement | null) => {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    editor.focus();
    let range = supplied ?? lastRangeRef.current;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    } else {
      range = range.cloneRange();
    }
    if (existing?.contains(range.startContainer)) return;
    if (existing) existing.remove();
    range.deleteContents();
    const node = existing ?? makeReference(item, number);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    activateRange(range);
    serialize();
  };

  useImperativeHandle(ref, () => ({
    insertReference: (item, number) => insertAt(item, number),
    removeReferences: (id) => {
      const editor = editorRef.current;
      if (!editor) return;
      Array.from(editor.querySelectorAll<HTMLElement>('[data-quote-id]'))
        .filter((node) => node.dataset.quoteId === id)
        .forEach((node) => node.remove());
      serialize();
    },
    focus: () => editorRef.current?.focus(),
  }));

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || value === ownValueRef.current) return;
    ownValueRef.current = value;
    if (!value) {
      editor.replaceChildren();
      lastRangeRef.current = null;
    } else {
      const pattern = /\uE000vulcan-(quote|reference|element):([a-zA-Z0-9_-]+)\uE001/g;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of value.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (index > cursor) fragment.append(document.createTextNode(value.slice(cursor, index)));
        const itemIndex = itemsRef.current.findIndex((item) => item.id === match[2] && item.kind === match[1]);
        if (itemIndex >= 0) fragment.append(makeReference(itemsRef.current[itemIndex], itemIndex + 1));
        else fragment.append(document.createTextNode(match[0]));
        cursor = index + match[0].length;
      }
      if (cursor < value.length) fragment.append(document.createTextNode(value.slice(cursor)));
      editor.replaceChildren(fragment);
    }
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.querySelectorAll<HTMLElement>('[data-quote-id]').forEach((node) => {
      const index = items.findIndex((item) => item.id === (node.dataset.contextId ?? node.dataset.quoteId));
      if (index < 0) {
        node.remove();
      } else {
        node.textContent = String(index + 1);
        node.style.setProperty('--quote-color', QUOTE_COLORS[index % QUOTE_COLORS.length]);
      }
    });
  }, [items]);

  const applyMarkdownShortcut = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.isCollapsed || !selection.rangeCount) return false;
    const caret = selection.getRangeAt(0);
    if (caret.startContainer.nodeType !== Node.TEXT_NODE || !editor.contains(caret.startContainer)) return false;
    const text = caret.startContainer as Text;
    const preceding = text.data.slice(0, caret.startOffset);
    const patterns: { regex: RegExp; tag: string; padded?: boolean; preservePrefix?: boolean }[] = [
      { regex: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/, tag: 'a' },
      { regex: /\*\*([^*\n]+)\*\*$/, tag: 'strong' },
      { regex: /(?<![\\`])``((?:[^`\n]|`(?!`))+?)``$/, tag: 'code', padded: true },
      { regex: /(?<![\\`])`([^`\n]+)`$/, tag: 'code' },
      { regex: /(?:^|[^*])\*([^*\n]+)\*$/, tag: 'em', preservePrefix: true },
    ];
    for (const pattern of patterns) {
      const match = preceding.match(pattern.regex);
      if (!match) continue;
      const prefixLength = pattern.preservePrefix && match[0][0] !== '*' ? 1 : 0;
      const replacement = document.createElement(pattern.tag);
      let contents = match[1];
      if (pattern.padded && contents.startsWith(' ') && contents.endsWith(' ') && /[^ ]/.test(contents)) {
        contents = contents.slice(1, -1);
      }
      replacement.textContent = contents;
      if (replacement instanceof HTMLAnchorElement) {
        replacement.href = match[2];
        replacement.target = '_blank';
        replacement.rel = 'noopener noreferrer';
      }
      const range = document.createRange();
      range.setStart(text, caret.startOffset - match[0].length + prefixLength);
      range.setEnd(text, caret.startOffset);
      range.deleteContents();
      range.insertNode(replacement);
      range.setStartAfter(replacement);
      range.collapse(true);
      activateRange(range);
      return true;
    }
    return false;
  };

  const applyCodeBlockShortcut = (pendingWhitespace: string): boolean => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.isCollapsed || !selection.rangeCount) return false;
    const caret = selection.getRangeAt(0);
    if (caret.startContainer.nodeType !== Node.TEXT_NODE || !editor.contains(caret.startContainer)) return false;
    if (caret.startContainer.parentElement?.closest('pre.vulcan-composer-code-block')) return false;
    const text = caret.startContainer as Text;
    const preceding = text.data.slice(0, caret.startOffset).replace(/\u00a0/g, ' ');
    const opening = (preceding + pendingWhitespace).match(/(?<![a-z0-9_+.\-\\`~])([a-z][a-z0-9_+.\-]*)?(```|~~~)([a-z][a-z0-9_+.\-]*)?[\s\n]$/i);
    if (!opening) return false;
    const language = (opening[3] || opening[1] || '').toLowerCase();
    const range = document.createRange();
    range.setStart(text, caret.startOffset - opening[0].length + pendingWhitespace.length);
    range.setEnd(text, caret.startOffset);
    range.deleteContents();
    const block = document.createElement('pre');
    block.className = 'vulcan-composer-code-block';
    if (language) block.dataset.language = language;
    const code = document.createElement('code');
    if (language) code.className = `language-${language}`;
    const contents = document.createTextNode('');
    code.appendChild(contents);
    block.appendChild(code);
    range.insertNode(block);
    range.setStart(contents, 0);
    range.collapse(true);
    activateRange(range);
    serialize();
    return true;
  };

  const handleInput = (_event: FormEvent<HTMLDivElement>) => {
    applyMarkdownShortcut();
    rememberSelection();
    serialize();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if ((event.key === ' ' || event.key === 'Enter') && applyCodeBlockShortcut(event.key === 'Enter' ? '\n' : ' ')) {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    const selection = window.getSelection();
    const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const owner = current?.startContainer.nodeType === Node.TEXT_NODE
      ? current.startContainer.parentElement
      : current?.startContainer as HTMLElement | undefined;
    const block = owner?.closest('pre.vulcan-composer-code-block');
    if (block && current) {
      event.preventDefault();
      const prior = current.startContainer.nodeType === Node.TEXT_NODE
        ? (current.startContainer as Text).data.slice(0, current.startOffset)
        : '';
      if (prior.endsWith('\n')) {
        (current.startContainer as Text).deleteData(current.startOffset - 1, 1);
        const next = document.createElement('div');
        next.appendChild(document.createElement('br'));
        block.after(next);
        current.setStart(next, 0);
      } else {
        const newline = document.createTextNode('\n');
        current.deleteContents();
        current.insertNode(newline);
        current.setStart(newline, 1);
      }
      current.collapse(true);
      activateRange(current);
      serialize();
      return;
    }
    event.preventDefault();
    onSubmit();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes(QUOTE_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const payload = JSON.parse(event.dataTransfer.getData(QUOTE_DRAG_TYPE)) as {
        id: string; referenceId?: string; origin?: string;
      };
      const index = itemsRef.current.findIndex((item) => item.id === payload.id);
      if (index < 0 || !editorRef.current) return;
      const target = caretRangeAtPoint(editorRef.current, event.clientX, event.clientY);
      const existing = payload.origin === 'inline'
        ? Array.from(editorRef.current.querySelectorAll<HTMLElement>('[data-reference-id]'))
          .find((node) => node.dataset.referenceId === payload.referenceId)
        : undefined;
      event.dataTransfer.dropEffect = existing ? 'move' : 'copy';
      insertAt(itemsRef.current[index], index + 1, target, existing);
    } catch {
      // Ignore data supplied by unrelated drag sources.
    }
  };

  return (
    <>
      {items.length > 0 && (
        <div className="vulcan-quote-shelf" aria-label="Selected quotations and files">
          {items.map((item, index) => (
            <div
              key={item.id}
              className="vulcan-quote-card"
              data-vulcan-context-card-id={item.id}
              data-vulcan-quote-card-id={item.id}
              draggable={!disabled}
              style={{ '--quote-color': QUOTE_COLORS[index % QUOTE_COLORS.length] } as React.CSSProperties}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData(QUOTE_DRAG_TYPE, JSON.stringify({ id: item.id, origin: 'card' }));
              }}
              title={item.kind === 'quote'
                ? item.text
                : item.kind === 'reference'
                  ? `${item.path}${item.startLine ? `:${item.startLine}${item.endLine !== item.startLine ? `–${item.endLine}` : ''}` : ''}${item.revision ? ` @ ${item.revision.slice(0, 8)}` : ''}`
                  : `${item.tagName} · ${item.hierarchyAddress}`}
            >
              <sup className="vulcan-quote-card-number">{index + 1}</sup>
              <button type="button" className="vulcan-quote-card-remove" onClick={() => onRemoveItem(item.id)} aria-label={`Remove ${item.kind} ${index + 1}`}>
                <X className="h-3 w-3" />
              </button>
              <span className="vulcan-quote-card-excerpt">
                {item.kind === 'quote'
                  ? item.text
                  : item.kind === 'reference'
                    ? <><FileCode className="inline h-3 w-3 mr-1" />{item.path.split('/').pop()}{item.startLine ? `:${item.startLine}${item.endLine !== item.startLine ? `–${item.endLine}` : ''}` : ''}{item.revision ? ` @ ${item.revision.slice(0, 8)}` : ''}</>
                    : <><MousePointer2 className="inline h-3 w-3 mr-1" />{item.tagName}{item.text ? ` · ${item.text}` : ''}</>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div
        ref={editorRef}
        className="vulcan-rich-composer"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-label="Type your message"
        aria-multiline="true"
        data-placeholder="Type your message..."
        onInput={handleInput}
        onFocus={onFocus}
        onPaste={onPaste}
        onKeyDown={handleKeyDown}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onBlur={rememberSelection}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes(QUOTE_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={handleDrop}
      />
    </>
  );
});
