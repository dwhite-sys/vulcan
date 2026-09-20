const { ipcRenderer, contextBridge } = require('electron');


// A Design page lives at a private vulcan-design:// origin. Native WebSocket
// only accepts ws:/wss:, so install a main-world wrapper before application
// scripts run. The app continues to observe its logical vulcan-design URL while
// the actual socket crosses the current Vulcan client/server connection.
const designTransport = location.protocol === 'vulcan-design:'
  ? ipcRenderer.sendSync('vulcan-design-transport-resolve', { originHost: location.hostname })
  : null;

if (designTransport?.wsBase && designTransport?.chatId && designTransport?.designId) {
  contextBridge.executeInMainWorld({
    func: (transport) => {
      const NativeWebSocket = globalThis.WebSocket;
      if (!NativeWebSocket) return;
      const logicalUrls = new WeakMap();
      class VulcanDesignWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
          const logical = new URL(String(url), location.href);
          const targetPath = String(transport.targetPath || '/');
          const basePath = targetPath.endsWith('/') ? targetPath : targetPath + '/';
          const withinBase = logical.pathname === targetPath || logical.pathname.startsWith(basePath);
          const suffix = withinBase
            ? logical.pathname.slice(targetPath.length).replace(/^\/+/, '')
            : logical.pathname.replace(/^\/+/, '');
          const physical = new URL(`${String(transport.wsBase).replace(/\/$/, '')}/design/${encodeURIComponent(transport.chatId)}/${encodeURIComponent(transport.designId)}/${suffix}`);
          physical.search = logical.search;
          if (transport.sessionToken) physical.searchParams.set('vulcan_session', transport.sessionToken);
          if (!withinBase) physical.searchParams.set('vulcan_design_root', '1');
          super(physical.toString(), protocols);
          logicalUrls.set(this, logical.toString());
        }
        get url() {
          return logicalUrls.get(this) || super.url;
        }
      }
      Object.defineProperties(VulcanDesignWebSocket, {
        CONNECTING: { value: NativeWebSocket.CONNECTING },
        OPEN: { value: NativeWebSocket.OPEN },
        CLOSING: { value: NativeWebSocket.CLOSING },
        CLOSED: { value: NativeWebSocket.CLOSED },
      });
      globalThis.WebSocket = VulcanDesignWebSocket;
    },
    args: [designTransport],
  });
}

let selecting = false;
let designContext = null;
let overlay = null;
let label = null;
let hovered = null;
let inspectionHandles = new Map();
let locatorElements = new Map();

function boundedText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function quote(value) {
  return `'${String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function accessibleName(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return boundedText(aria, 100);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    if (text.trim()) return boundedText(text, 100);
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.labels?.length) return boundedText(Array.from(el.labels).map((item) => item.innerText).join(' '), 100);
    if (el.placeholder) return boundedText(el.placeholder, 100);
  }
  if (el instanceof HTMLImageElement && el.alt) return boundedText(el.alt, 100);
  return boundedText(el.innerText || el.textContent || el.getAttribute('title') || '', 100);
}

function semanticRole(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'img') return 'img';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'article') return 'article';
  if (tag === 'nav') return 'navigation';
  if (tag === 'main') return 'main';
  if (tag === 'form') return 'form';
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['button', 'submit', 'reset'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  return '';
}

function uniqueCss(selector) {
  try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
}

function structuralSelector(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    let part = tag;
    const useful = Array.from(node.classList).filter((name) => name && !/^(css-|sc-|jsx-|_|[a-f0-9]{6,})/i.test(name)).slice(0, 2);
    if (useful.length) part += useful.map((name) => `.${cssEscape(name)}`).join('');
    if (!uniqueCss([part, ...parts].join(' > '))) {
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    if (parts.length >= 6) break;
    node = node.parentElement;
  }
  return parts.join(' > ') || el.tagName.toLowerCase();
}

function playwrightLocator(el) {
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
  if (testId) return `getByTestId(${quote(testId)})`;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const labelText = el.labels?.length ? boundedText(Array.from(el.labels).map((item) => item.innerText).join(' '), 100) : '';
    if (labelText) return `getByLabel(${quote(labelText)})`;
    if (el.placeholder) return `getByPlaceholder(${quote(el.placeholder)})`;
  }

  const role = semanticRole(el);
  const name = accessibleName(el);
  if (role && name) return `getByRole(${quote(role)}, { name: ${quote(name)} })`;
  if (role && ['main', 'navigation'].includes(role)) return `getByRole(${quote(role)})`;

  if (el.id && uniqueCss(`#${cssEscape(el.id)}`)) return `locator(${quote(`#${cssEscape(el.id)}`)})`;
  const attrName = el.getAttribute('name');
  if (attrName) return `locator(${quote(`${el.tagName.toLowerCase()}[name="${attrName.replace(/"/g, '\\"')}"]`)})`;
  if (name && name.length <= 80) return `getByText(${quote(name)}, { exact: true })`;
  return `locator(${quote(structuralSelector(el))})`;
}

function hierarchyAddress(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement && parts.length < 6) {
    const tag = node.tagName.toLowerCase();
    let part = tag;
    if (node.id) part += `#${node.id}`;
    else {
      const role = semanticRole(node);
      const name = accessibleName(node);
      const useful = Array.from(node.classList).filter((value) => value && !/^(css-|sc-|jsx-|_|[a-f0-9]{6,})/i.test(value)).slice(0, 1);
      if (useful.length) part += `.${useful[0]}`;
      else if (role && name && name.length < 42) part += `[${role}="${name}"]`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function filteredAttributes(el) {
  const allowed = ['id', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'data-testid', 'data-test-id', 'data-test', 'name', 'type', 'href', 'title', 'placeholder', 'alt'];
  const out = {};
  for (const name of allowed) {
    const value = el.getAttribute(name);
    if (value) out[name] = boundedText(value, 180);
  }
  return out;
}


function semanticLocation() {
  const fallbackRoute = `${location.pathname}${location.search}${location.hash}`;
  if (!designContext?.targetUrl) return { url: location.href, route: fallbackRoute };
  try {
    const target = new URL(designContext.targetUrl);
    const prefix = String(designContext.proxyPathPrefix || '');
    let route;
    if (prefix && location.pathname.startsWith(prefix)) {
      const suffix = location.pathname.slice(prefix.length);
      let basePath = target.pathname || '/';
      if (!basePath.endsWith('/')) basePath += '/';
      route = new URL(suffix || '.', `${target.origin}${basePath}`).pathname;
      if (!suffix) route = target.pathname || '/';
      const query = suffix ? location.search : (target.search || location.search);
      route += `${query}${location.hash}`;
    } else {
      route = fallbackRoute;
    }
    return { url: `${target.origin}${route}`, route };
  } catch {
    return { url: location.href, route: fallbackRoute };
  }
}

function ensureOverlay() {
  if (overlay?.isConnected) return;
  overlay = document.createElement('div');
  overlay.setAttribute('data-vulcan-live-selector-overlay', 'true');
  Object.assign(overlay.style, {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', display: 'none',
    border: '2px solid #4d9cff', background: 'rgba(77,156,255,.10)', borderRadius: '3px',
    boxSizing: 'border-box', boxShadow: '0 0 0 1px rgba(255,255,255,.18) inset',
  });
  label = document.createElement('div');
  Object.assign(label.style, {
    position: 'absolute', left: '-2px', bottom: '100%', marginBottom: '4px', maxWidth: '360px',
    padding: '3px 6px', borderRadius: '4px', background: '#1f5f9d', color: 'white',
    font: '11px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  });
  overlay.appendChild(label);
  document.documentElement.appendChild(overlay);
}

function hideOverlay() {
  if (overlay) overlay.style.display = 'none';
  hovered = null;
}

function updateOverlay(el) {
  ensureOverlay();
  const rect = el.getBoundingClientRect();
  hovered = el;
  Object.assign(overlay.style, {
    display: rect.width > 0 && rect.height > 0 ? 'block' : 'none',
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  });
  if (label) label.textContent = `${el.tagName.toLowerCase()}${accessibleName(el) ? ` · ${accessibleName(el)}` : ''}`;
}

function selectableTarget(event) {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  if (target.closest('[data-vulcan-live-selector-overlay]')) return null;
  return target;
}

function onMove(event) {
  if (!selecting) return;
  const target = selectableTarget(event);
  if (target && target !== hovered) updateOverlay(target);
}

function onLeave() { if (selecting) hideOverlay(); }

function onClick(event) {
  if (!selecting) return;
  const el = selectableTarget(event);
  if (!el) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  const locator = rememberElement(el);
  const payload = {
    locator,
    hierarchyAddress: hierarchyAddress(el),
    tagName: el.tagName.toLowerCase(),
    text: boundedText(el.innerText || el.textContent || '', 240) || undefined,
    ...semanticLocation(),
    attributes: filteredAttributes(el),
  };
  selecting = false;
  hideOverlay();
  ipcRenderer.sendToHost('vulcan-design-element', payload);
}

function onKey(event) {
  if (selecting && event.key === 'Escape') {
    selecting = false;
    hideOverlay();
    event.preventDefault();
    event.stopPropagation();
    ipcRenderer.sendToHost('vulcan-design-select-cancelled');
  }
}


function isVisible(el) {
  if (!(el instanceof Element)) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0
    && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}

function rememberElement(el, handle) {
  const locator = playwrightLocator(el);
  locatorElements.set(locator, el);
  if (handle) inspectionHandles.set(handle, el);
  return locator;
}

function decodeQuoted(value) {
  return String(value || '').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function findByTextExact(text) {
  const candidates = document.querySelectorAll('body *');
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const own = boundedText(el.innerText || el.textContent || '', 180);
    if (own === text) return el;
  }
  return null;
}

function resolveTarget(target) {
  const key = String(target || '').trim();
  if (!key) return null;
  const byHandle = inspectionHandles.get(key);
  if (byHandle?.isConnected) return byHandle;
  const byLocator = locatorElements.get(key);
  if (byLocator?.isConnected) return byLocator;

  let match = key.match(/^getByTestId\('((?:\\'|[^'])*)'\)$/);
  if (match) {
    const value = decodeQuoted(match[1]);
    return document.querySelector(`[data-testid="${cssEscape(value)}"], [data-test-id="${cssEscape(value)}"], [data-test="${cssEscape(value)}"]`);
  }
  match = key.match(/^getByPlaceholder\('((?:\\'|[^'])*)'\)$/);
  if (match) {
    const value = decodeQuoted(match[1]);
    return Array.from(document.querySelectorAll('input, textarea')).find((el) => el.getAttribute('placeholder') === value) || null;
  }
  match = key.match(/^getByLabel\('((?:\\'|[^'])*)'\)$/);
  if (match) {
    const value = decodeQuoted(match[1]);
    const labelled = Array.from(document.querySelectorAll('input, textarea, select, button')).find((el) => {
      if (el.getAttribute('aria-label') === value) return true;
      if ('labels' in el && el.labels?.length) return boundedText(Array.from(el.labels).map((item) => item.innerText).join(' '), 100) === value;
      return false;
    });
    return labelled || null;
  }
  match = key.match(/^getByRole\('((?:\\'|[^'])*)'(?:, \{ name: '((?:\\'|[^'])*)' \})?\)$/);
  if (match) {
    const role = decodeQuoted(match[1]);
    const name = match[2] == null ? null : decodeQuoted(match[2]);
    return Array.from(document.querySelectorAll('body *')).find((el) => semanticRole(el) === role && (name == null || accessibleName(el) === name)) || null;
  }
  match = key.match(/^locator\('((?:\\'|[^'])*)'\)$/);
  if (match) {
    try { return document.querySelector(decodeQuoted(match[1])); } catch { return null; }
  }
  match = key.match(/^getByText\('((?:\\'|[^'])*)', \{ exact: true \}\)$/);
  if (match) return findByTextExact(decodeQuoted(match[1]));
  return null;
}

function targetOrError(target) {
  const el = resolveTarget(target);
  if (!el) throw new Error('target_not_found');
  el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  rememberElement(el);
  return el;
}

function compactInteractive(el, handle) {
  const role = semanticRole(el) || el.tagName.toLowerCase();
  const name = accessibleName(el);
  const locator = rememberElement(el, handle);
  const item = { handle, role, locator };
  if (name) item.name = name;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.type !== 'password') item.value = boundedText(el.value, 160);
    if ('disabled' in el && el.disabled) item.disabled = true;
    if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) item.checked = el.checked;
  }
  return item;
}

function inspectSurface() {
  inspectionHandles = new Map();
  locatorElements = new Map();
  const selector = [
    'button', 'a[href]', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]', '[role="radio"]',
    '[role="combobox"]', '[role="slider"]', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
  ].join(',');
  const interactive = [];
  for (const el of document.querySelectorAll(selector)) {
    if (!isVisible(el)) continue;
    const handle = `e${interactive.length + 1}`;
    interactive.push(compactInteractive(el, handle));
    if (interactive.length >= 40) break;
  }
  const lines = String(document.body?.innerText || '')
    .split(/\n+/)
    .map((line) => boundedText(line, 220))
    .filter(Boolean);
  const visibleText = [];
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    visibleText.push(line);
    if (visibleText.length >= 30 || visibleText.join('\n').length >= 1800) break;
  }
  return {
    ...semanticLocation(),
    title: document.title || undefined,
    visible_text: visibleText,
    interactive,
  };
}

function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function parseKeyShortcut(value) {
  const pieces = String(value || '').split('+').map((part) => part.trim()).filter(Boolean);
  const rawKey = pieces.pop() || '';
  const mods = new Set(pieces.map((part) => part.toLowerCase()));
  const aliases = { esc: 'Escape', return: 'Enter', space: ' ', del: 'Delete' };
  const key = aliases[rawKey.toLowerCase()] || (rawKey.length === 1 ? rawKey : rawKey[0]?.toUpperCase() + rawKey.slice(1));
  return {
    key,
    ctrlKey: mods.has('control') || mods.has('ctrl'),
    altKey: mods.has('alt') || mods.has('option'),
    shiftKey: mods.has('shift'),
    metaKey: mods.has('meta') || mods.has('cmd') || mods.has('command'),
  };
}

function pressKey(target, shortcut) {
  const el = target ? targetOrError(target) : (document.activeElement instanceof Element ? document.activeElement : document.body);
  el.focus?.();
  const opts = { ...parseKeyShortcut(shortcut), bubbles: true, cancelable: true, composed: true };
  const down = new KeyboardEvent('keydown', opts);
  const allowed = el.dispatchEvent(down);
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  if (allowed && opts.key === 'Enter' && el instanceof HTMLElement) el.closest('form')?.requestSubmit?.();
  if (allowed && opts.key === 'Tab') {
    const focusable = Array.from(document.querySelectorAll('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])')).filter(isVisible);
    const index = focusable.indexOf(el);
    if (focusable.length) focusable[(index + (opts.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus?.();
  }
  return { ok: true, key: shortcut, target: target || null, route: semanticLocation().route };
}

function runDesignTool(toolName, args = {}) {
  if (toolName === '__design_target_point') {
    const el = targetOrError(args.target);
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), route: semanticLocation().route };
  }
  if (toolName === '__design_focus') {
    const el = targetOrError(args.target);
    el.focus?.({ preventScroll: true });
    return { ok: true };
  }
  if (toolName === 'design_inspect') return inspectSurface();
  if (toolName === 'design_click') {
    const el = targetOrError(args.target);
    el.click?.();
    return { ok: true, target: args.target, route: semanticLocation().route };
  }
  if (toolName === 'design_fill') {
    const el = targetOrError(args.target);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.isContentEditable) throw new Error('target_not_editable');
    if (el.isContentEditable) {
      el.textContent = String(args.value ?? '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: String(args.value ?? '') }));
    } else setNativeValue(el, String(args.value ?? ''));
    return { ok: true, target: args.target, value: String(args.value ?? '') };
  }
  if (toolName === 'design_press') return pressKey(args.target, args.key);
  if (toolName === 'design_hover') {
    const el = targetOrError(args.target);
    for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter', composed: true, view: window }));
    }
    return { ok: true, target: args.target };
  }
  if (toolName === 'design_scroll') {
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('invalid_scroll_amount');
    const direction = String(args.direction || '');
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    if (!dx && !dy) throw new Error('invalid_scroll_direction');
    const target = args.target ? targetOrError(args.target) : null;
    if (target) target.scrollBy?.({ left: dx, top: dy, behavior: 'instant' });
    else window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    return { ok: true, direction, amount, target: args.target || null };
  }
  if (toolName === 'design_select_option') {
    const el = targetOrError(args.target);
    if (!(el instanceof HTMLSelectElement)) throw new Error('target_not_select');
    const requested = String(args.value ?? '');
    const option = Array.from(el.options).find((item) => item.value === requested || boundedText(item.textContent || '', 180) === requested);
    if (!option) throw new Error('option_not_found');
    setNativeValue(el, option.value);
    return { ok: true, target: args.target, value: option.value, label: boundedText(option.textContent || '', 180) };
  }
  if (toolName === 'design_get_text') {
    const el = targetOrError(args.target);
    return { target: args.target, text: boundedText(el.innerText || el.textContent || '', 4000) };
  }
  if (toolName === 'design_get_attribute') {
    const el = targetOrError(args.target);
    const attribute = String(args.attribute || '').trim();
    if (!attribute) throw new Error('attribute_required');
    return { target: args.target, attribute, value: el.getAttribute(attribute) };
  }
  throw new Error('unknown_design_surface_tool');
}

window.addEventListener('DOMContentLoaded', () => {
  ensureOverlay();
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseleave', onLeave, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
});

ipcRenderer.on('vulcan-design-context', (_event, value) => {
  designContext = value && typeof value === 'object' ? value : null;
});

ipcRenderer.on('vulcan-design-select-mode', (_event, enabled) => {
  selecting = Boolean(enabled);
  if (!selecting) hideOverlay();
});


ipcRenderer.on('vulcan-design-tool-request', (_event, payload) => {
  const requestId = payload?.requestId;
  if (!requestId) return;
  try {
    const result = runDesignTool(String(payload.toolName || ''), payload.args || {});
    ipcRenderer.sendToHost('vulcan-design-tool-response', { requestId, result });
  } catch (error) {
    ipcRenderer.sendToHost('vulcan-design-tool-response', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
