/**
 * panelCache.ts — localStorage-backed store for panel HTML/CSS/JS content.
 *
 * Panel metadata (name, updatedAt, messageId) lives on Message objects in chat
 * history. Panel *content* lives here, keyed by chatId+name, so we don't bloat
 * the chat history with potentially large HTML/CSS/JS strings.
 *
 * Keys: vulcan:panel:{chatId}:{name}
 * Values: JSON { html, css, js }
 */

const PREFIX = 'vulcan:panel:';

export interface PanelContent {
  html: string;
  css?: string;
  js?: string;
}

function key(chatId: string, name: string): string {
  return `${PREFIX}${chatId}:${name}`;
}

export function savePanel(chatId: string, name: string, content: PanelContent): void {
  try {
    localStorage.setItem(key(chatId, name), JSON.stringify(content));
  } catch { /* storage full — ignore */ }
}

export function loadPanel(chatId: string, name: string): PanelContent | null {
  try {
    const raw = localStorage.getItem(key(chatId, name));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function deletePanel(chatId: string, name: string): void {
  try {
    localStorage.removeItem(key(chatId, name));
  } catch { /* ignore */ }
}

/** Remove all panel cache entries for a chat. Call when a chat is deleted. */
export function deleteChatPanels(chatId: string): void {
  try {
    const prefix = `${PREFIX}${chatId}:`;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

/** Build a full standalone HTML document from panel parts. */
export function buildPanelDocument(content: PanelContent): string {
  const { html, css, js } = content;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 8px;
      background: #18181b;
      color: #e4e4e7;
      font-family: sans-serif;
      font-size: 14px;
    }
  </style>
  ${css ? `<style>\n${css}\n  </style>` : ''}
</head>
<body>
${html}
${js ? `  <script>\n${js}\n  </script>` : ''}
</body>
</html>`;
}
