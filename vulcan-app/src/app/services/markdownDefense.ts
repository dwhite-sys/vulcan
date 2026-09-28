/**
 * Provider streams can occasionally split Markdown fences away from the text they
 * were meant to surround (for example an assistant_text event containing only
 * "```html", followed by a reasoning event, then a "```" event). Persist those
 * bytes exactly as received, but do not give fence-only fragments visual chrome.
 */
export function isIsolatedMarkdownFence(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return /^```[A-Za-z0-9_.+-]*$/.test(trimmed) || /^~~~[A-Za-z0-9_.+-]*$/.test(trimmed);
}

/** ReactMarkdown may supply no children for an empty fenced block. String(undefined)
 * becomes the literal text "undefined", so normalize absence to an empty string. */
export function codeChildrenToString(children: unknown): string {
  if (children === null || children === undefined) return '';
  return String(children).replace(/\n$/, '');
}
