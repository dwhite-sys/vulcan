/**
 * vulcan.ts — Vulcan API client
 *
 * All operations route through the General WebSocket (/ws/general).
 * Application data routes through the encrypted General WebSocket.
 * Terminal streaming uses the Terminal WebSocket per slot (see ws.ts).
 */

import type { GitCommit, FileSnapshot, TimelineEntry } from '../types/vulcan';
import { wsRequest, generalWS } from './ws';
import { getVulcanBaseUrl, getVulcanWsBaseUrl } from './vulcanEndpoint';

export { generalWS };

function designOriginHost(designId: string): string {
  const bytes = new TextEncoder().encode(designId);
  return `d-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function designProxyUrl(_chatId: string, designId: string, targetUrl?: string): string {
  const logical = new URL(`vulcan-design://${designOriginHost(designId)}/`);
  if (targetUrl) {
    try {
      const target = new URL(targetUrl);
      logical.pathname = target.pathname || '/';
      logical.search = target.search;
    } catch { /* registration validation owns malformed target errors */ }
  }
  return logical.toString();
}

export async function configureDesignTransport(chatId: string, designId: string, targetUrl?: string): Promise<void> {
  const api = (window as any).electronAPI?.designTransport;
  if (!api?.configure) throw new Error('Design transport requires the Electron desktop runtime');
  const partition = `persist:vulcan-design-${chatId}`;
  await api.configure({
    partition,
    originHost: designOriginHost(designId),
    chatId,
    designId,
    httpBase: getVulcanBaseUrl(),
    wsBase: getVulcanWsBaseUrl(),
    sessionToken: generalWS.sessionToken || '',
    targetUrl: targetUrl || '',
  });
}

// Plain HTTP is retained only for non-sensitive readiness checks.
async function restGet(path: string): Promise<any> {
  const res = await fetch(`${getVulcanBaseUrl()}${path}`);
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error ?? `Vulcan ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

async function restPost(path: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${getVulcanBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error ?? `Vulcan ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

// ── Connection ────────────────────────────────────────────────────────────────

export async function testVulcanConnection(): Promise<boolean> {
  try { await restGet('/ping'); return true; } catch { return false; }
}

export async function getAuthStatus(): Promise<{ requires_auth: boolean }> {
  return restGet('/auth/status');
}

/** Lightweight server-owned projection; tagging never enters agent context. */
export async function loadChatTopics(): Promise<Record<string, string[]>> {
  const data = await wsRequest('chats/topics', {});
  return data.tags ?? {};
}

export interface TranscriptSearchHitDescriptor {
  event_id: string;
  event_type: string;
  /** Direct matched message text returned by FTS5. */
  message?: string;
  timestamp?: string;
  /** Exact offsets are optional and only used by legacy/exact-hit callers. */
  start?: number;
  end?: number;
  occurrence?: number;
}

export interface ChatTranscriptSearchResult {
  chat_ids: string[];
  hits_by_chat: Record<string, TranscriptSearchHitDescriptor[]>;
}

export interface BranchTranscriptSearchResult {
  branch_ids: string[];
  hits_by_branch: Record<string, TranscriptSearchHitDescriptor[]>;
}

export async function searchChats(query: string): Promise<ChatTranscriptSearchResult> {
  const data = await wsRequest('chats/search', { query });
  return { chat_ids: data.chat_ids ?? [], hits_by_chat: data.hits_by_chat ?? {} };
}

export async function searchBranches(chatId: string, query: string): Promise<BranchTranscriptSearchResult> {
  const data = await wsRequest('chats/branch-search', { chat_id: chatId, query });
  return { branch_ids: data.branch_ids ?? [], hits_by_branch: data.hits_by_branch ?? {} };
}

export interface LibraryFile {
  file_id: string;
  name: string;
  path: string;
  size: number;
  modified_at: string;
  content_type: string;
  kind?: 'file' | 'directory';
  source?: 'library' | 'workspace' | 'attachment';
  chat_id?: string;
}

export async function libraryStatus(): Promise<{ path: string; count: number }> {
  return wsRequest('library/status', {});
}

export async function searchLibrary(query = '', limit = 20): Promise<{ results: LibraryFile[]; count: number }> {
  return wsRequest('library/search', { query, limit });
}

export async function attachLibraryFile(chatId: string, fileId: string, destination?: string): Promise<Record<string, any>> {
  return wsRequest('library/attach', { chat_id: chatId, file_id: fileId, ...(destination ? { destination } : {}) });
}

// ── Shell (legacy — kept for backward compat with TerminalWidget) ─────────────

export async function startShell(chatId: string): Promise<string> {
  const data = await wsRequest('terminal/slot/open', { chat_id: chatId, kind: 'user' });
  return String(data.slot);
}

export function streamShell(
  chatId: string,
  onChunk: (chunk: string) => void,
  onDone: () => void,
): () => void {
  const es = new EventSource(
    `${getVulcanBaseUrl()}/terminal/shell/stream?chat_id=${encodeURIComponent(chatId)}`
      + (generalWS.sessionToken ? `&vulcan_session=${encodeURIComponent(generalWS.sessionToken)}` : '')
  );
  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.done) { onDone(); es.close(); }
    else if (data.chunk) { onChunk(data.chunk); }
  };
  es.onerror = () => { onDone(); es.close(); };
  return () => es.close();
}

export async function sendInput(pid: string, text: string): Promise<boolean> {
  const data = await wsRequest('terminal/detach', { pid, text });
  return data.ok;
}

export async function resizeShell(chatId: string, cols: number, rows: number): Promise<void> {
  // No longer needed — slots handle resize via WS
}

// ── Commands ──────────────────────────────────────────────────────────────────

export async function runCommand(
  chatId: string, cmd: string, timeout = 180, background = false,
): Promise<string> {
  // Compatibility path: execute through the encrypted general channel.
  const slots = await wsRequest('terminal/slots', { chat_id: chatId });
  let agent = (slots.slots ?? []).find((entry: any) => entry.kind === 'agent');
  if (!agent) {
    const opened = await wsRequest('terminal/slot/open', { chat_id: chatId, kind: 'agent' });
    agent = { slot: opened.slot };
  }
  const data = await wsRequest('terminal/slot/run', { chat_id: chatId, kind: 'agent', slot: agent.slot, cmd, timeout, background });
  return data.pid;
}

export async function waitForResult(pid: string, timeoutMs = 185_000): Promise<{ output: string; exit_code: number; detached: boolean; detach_reason: string; wake_reason?: string | null; webhook_method?: string | null; webhook_path?: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = await wsRequest('terminal/result', { pid });
      if (data.finished || data.detached) return data;
    } catch { return { output: 'Error retrieving result', exit_code: 1, detached: false, detach_reason: '' }; }
    await new Promise(r => setTimeout(r, 300));
  }
  return { output: 'Timed out', exit_code: 1, detached: false, detach_reason: '' };
}

export async function getCommandResult(pid: string): Promise<{
  pid: string; output: string; finished: boolean; exit_code: number; detached: boolean; detach_reason: string;
}> {
  return await wsRequest('terminal/result', { pid });
}

export async function detachProcess(pid: string, reason = ''): Promise<boolean> {
  const data = await wsRequest('terminal/detach', { pid, reason });
  return data.ok;
}

export async function killProcess(pid: string): Promise<boolean> {
  const data = await wsRequest('terminal/kill', { pid });
  return data.ok;
}

export async function startWait(chatId: string, seconds: number, webhookUrl?: string): Promise<string> {
  const data = await wsRequest('terminal/wait', {
    chat_id: chatId,
    seconds,
    ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
  });
  return data.pid;
}

// ── File operations ───────────────────────────────────────────────────────────

export async function readFile(chatId: string, path: string): Promise<string> {
  const data = await wsRequest('workspace/read-file', { chat_id: chatId, path });
  return data.content;
}

export async function writeFile(chatId: string, path: string, content: string): Promise<void> {
  await wsRequest('workspace/write-file', { chat_id: chatId, path, content });
}

export async function createDirectory(chatId: string, path: string): Promise<void> {
  await wsRequest('workspace/create-directory', { chat_id: chatId, path });
}

export interface FileEdit {
  start_line: number;
  end_line: number;
  anchor: string;
  replacement: string;
}

export interface FileEditResult {
  anchor: 'found';
  new_start: number;
  new_end: number;
}

export async function editFile(
  chatId: string,
  path: string,
  edits: FileEdit[],
): Promise<{ ok: boolean; edits: FileEditResult[] }> {
  return wsRequest('workspace/edit-file', { chat_id: chatId, path, edits });
}

export async function findInFile(
  chatId: string,
  path: string,
  query: string,
): Promise<{ line: number; content: string }[]> {
  const data = await wsRequest('workspace/find-in-file', { chat_id: chatId, path, query });
  return data.matches ?? [];
}

export async function readFileBase64(chatId: string, path: string): Promise<{ base64: string; mimeType: string }> {
  const data = await wsRequest('workspace/read-file-base64', { chat_id: chatId, path });
  return { base64: data.base64, mimeType: data.mimeType };
}

export async function listFiles(chatId: string): Promise<string[]> {
  const data = await wsRequest('workspace/list-files', { chat_id: chatId });
  return data.files ?? [];
}

export async function getWorkspacePath(chatId: string): Promise<string> {
  const data = await wsRequest('workspace/path', { chat_id: chatId });
  return data.path;
}

export async function presentFile(chatId: string, path: string): Promise<void> {
  await wsRequest('workspace/present', { chat_id: chatId, path });
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

export async function saveSnapshot(chatId: string, path: string): Promise<string> {
  const data = await wsRequest('snapshot/save', { chat_id: chatId, path });
  return data.id;
}

export async function getSnapshotContent(chatId: string, snapshotId: string, path: string): Promise<string> {
  const data = await wsRequest('snapshot/show', { chat_id: chatId, id: snapshotId, path });
  return data.content;
}

export async function listSnapshots(chatId: string, path: string): Promise<FileSnapshot[]> {
  const data = await wsRequest('snapshot/list', { chat_id: chatId, path });
  return (data.snapshots ?? []).map((s: any) => ({ id: s.id, path: s.path, timestamp: new Date(s.timestamp), source: s.source }));
}

// ── Git ───────────────────────────────────────────────────────────────────────

export async function gitLog(chatId: string, path?: string): Promise<GitCommit[]> {
  const data = await wsRequest('git/log', { chat_id: chatId, ...(path ? { path } : {}) });
  return (data.log ?? []).map((c: any) => ({ hash: c.hash, shortHash: c.shortHash, message: c.message, author: c.author, timestamp: new Date(c.timestamp) }));
}

export async function gitShow(chatId: string, hash: string, path: string): Promise<string> {
  const data = await wsRequest('git/show', { chat_id: chatId, hash, path });
  return data.content;
}

export async function gitCommit(chatId: string, message: string, paths?: string[]): Promise<string> {
  const data = await wsRequest('git/commit', { chat_id: chatId, message, ...(paths?.length ? { paths } : {}) });
  return data.hash ?? '';
}

export async function gitRestore(chatId: string, hash: string): Promise<void> {
  await wsRequest('git/restore', { chat_id: chatId, hash });
}

export async function gitRestoreFile(chatId: string, hash: string, path: string): Promise<void> {
  await wsRequest('git/restore-file', { chat_id: chatId, hash, path });
}

export async function hasChangedSinceLastCommit(chatId: string, path: string): Promise<boolean> {
  const data = await wsRequest('git/changed', { chat_id: chatId, path });
  return Boolean(data.changed);
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export async function getTimeline(chatId: string, path: string): Promise<TimelineEntry[]> {
  const [commits, snapshots] = await Promise.all([gitLog(chatId, path), listSnapshots(chatId, path)]);
  return [
    ...commits.map((c): TimelineEntry => ({ kind: 'commit', commit: c })),
    ...snapshots.map((s): TimelineEntry => ({ kind: 'snapshot', snapshot: s })),
  ].sort((a, b) => {
    const at = a.kind === 'commit' ? a.commit.timestamp : a.snapshot.timestamp;
    const bt = b.kind === 'commit' ? b.commit.timestamp : b.snapshot.timestamp;
    return bt.getTime() - at.getTime();
  });
}

// ── Container ─────────────────────────────────────────────────────────────────

export async function getContainerStatus(chatId: string): Promise<{ running: boolean; container_exists: boolean; image_exists: boolean; gpu_enabled: boolean }> {
  return wsRequest('container/status', { chat_id: chatId });
}

export async function ensureContainer(chatId: string): Promise<void> {
  await wsRequest('container/start', { chat_id: chatId });
}

export async function setOpenChatPresence(chatId: string | null): Promise<void> {
  await wsRequest('containers/chat-presence', { chat_id: chatId });
}

export async function rebuildContainer(): Promise<void> {
  await wsRequest('container/reset', {});
}

// ── Workspace management ──────────────────────────────────────────────────────

export interface WorkspaceMeta {
  chatId: string; chatTitle: string | null; sizeBytes: number; lastModified: Date;
}

export async function listWorkspaces(): Promise<WorkspaceMeta[]> {
  const data = await wsRequest('workspace/list-all', {});
  return (data.workspaces ?? []).map((w: any) => ({ chatId: w.chatId, chatTitle: w.chatTitle ?? null, sizeBytes: w.sizeBytes, lastModified: new Date(w.lastModified) }));
}

export async function deleteWorkspace(chatId: string): Promise<void> {
  await wsRequest('workspace/delete', { chat_id: chatId });
}

export async function renamePath(chatId: string, fromPath: string, toPath: string): Promise<void> {
  await wsRequest('workspace/rename-file', { chat_id: chatId, old_path: fromPath, new_path: toPath });
}

export async function deletePath(chatId: string, path: string): Promise<void> {
  await wsRequest('workspace/delete-file', { chat_id: chatId, path });
}

export interface WorkspaceExport {
  base64: string;
  filename: string;
  mimeType: string;
}

export interface PreparedWorkspaceExport {
  exportId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export async function exportWorkspaceItem(chatId: string, path: string): Promise<WorkspaceExport> {
  const data = await wsRequest('workspace/export', { chat_id: chatId, path });
  return {
    base64: data.base64 ?? '',
    filename: data.filename ?? path.split('/').pop() ?? 'workspace-export',
    mimeType: data.mimeType ?? 'application/octet-stream',
  };
}

export async function prepareWorkspaceExport(chatId: string, path: string): Promise<PreparedWorkspaceExport> {
  const data = await wsRequest('workspace/export/prepare', { chat_id: chatId, path });
  return {
    exportId: String(data.export_id ?? ''),
    filename: data.filename ?? path.split('/').pop() ?? 'workspace-export',
    mimeType: data.mimeType ?? 'application/octet-stream',
    size: Number(data.size ?? 0),
  };
}

export async function readWorkspaceExportChunk(exportId: string, offset: number, chunkSize = 384 * 1024): Promise<{ data: string; nextOffset: number; done: boolean }> {
  const data = await wsRequest('workspace/export/chunk', { export_id: exportId, offset, chunk_size: chunkSize });
  return {
    data: String(data.data ?? ''),
    nextOffset: Number(data.next_offset ?? offset),
    done: !!data.done,
  };
}

export async function finishWorkspaceExport(exportId: string): Promise<void> {
  await wsRequest('workspace/export/finish', { export_id: exportId });
}

export async function cancelWorkspaceExport(exportId: string): Promise<void> {
  await wsRequest('workspace/export/cancel', { export_id: exportId });
}

export async function downloadFolder(chatId: string, path: string, name: string): Promise<void> {
  const data = await wsRequest('workspace/download-folder', { chat_id: chatId, path });
  const binary = atob(data.base64 ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/zip' });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = `${name}.zip`;
  a.click();
  URL.revokeObjectURL(objectUrl);
}

// ── Chat persistence ──────────────────────────────────────────────────────────
// Chats are always stored on the local Vulcan server.

function getRemoteBase(): string {
  return getVulcanBaseUrl();
}

export async function remoteLoadChats(): Promise<any[]> {
  const data = await wsRequest('chats/list', { summary_only: true });
  return data.chats ?? [];
}

export async function remoteLoadChat(chatId: string): Promise<any | null> {
  try {
    const data = await wsRequest('chats/get', { chat_id: chatId });
    return data.chat ?? null;
  } catch {
    return null;
  }
}

export async function remoteSaveChat(chat: any): Promise<void> {
  await wsRequest('chats/upsert', { chat });
}

export async function remoteDeleteChat(chatId: string): Promise<void> {
  await wsRequest('chats/delete', { chat_id: chatId });
}

export async function remoteLoadChatFolders(): Promise<any[]> {
  const data = await wsRequest('chat-folders/list', {});
  return data.folders ?? [];
}

export async function remoteSaveChatFolders(folders: any[]): Promise<void> {
  await wsRequest('chat-folders/save', { folders });
}


// ── Bidirectional file transfers: encrypted WebSocket uploads ────────────────

const activeUploadCancels = new Map<string, () => void>();
let uploadCancelListenerInstalled = false;

function ensureUploadCancelListener() {
  if (uploadCancelListenerInstalled || typeof window === 'undefined') return;
  uploadCancelListenerInstalled = true;
  window.addEventListener('vulcan-transfer-cancel', (event: Event) => {
    const id = String((event as CustomEvent).detail?.id ?? '');
    activeUploadCancels.get(id)?.();
  });
}

function emitTransfer(detail: Record<string, unknown>) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('vulcan-transfer-progress', { detail }));
  }
}

function emitTransferComplete(detail: Record<string, unknown>) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('vulcan-transfer-complete', { detail }));
  }
}

export class VulcanTransferCancelledError extends Error {
  constructor() {
    super('Transfer cancelled');
    this.name = 'VulcanTransferCancelledError';
  }
}

export function isTransferCancelledError(error: unknown): boolean {
  return error instanceof VulcanTransferCancelledError || (error instanceof Error && error.name === 'VulcanTransferCancelledError');
}

export interface UploadOptions {
  transferId?: string;
  workspacePath?: string;
  library?: boolean;
  /** Internal/background materialization can avoid user-facing transfer chrome. */
  silent?: boolean;
}

async function uploadFileBytes(chatId: string, file: File, options: UploadOptions = {}): Promise<string> {
  ensureUploadCancelListener();
  const transferId = options.transferId ?? `upload:${chatId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const silent = options.silent === true;
  let cancelled = false;
  let uploadId: string | null = null;
  const cancel = () => { cancelled = true; };
  activeUploadCancels.set(transferId, cancel);

  const removeProgress = () => { if (!silent) emitTransfer({ id: transferId, remove: true }); };
  const assertNotCancelled = () => { if (cancelled) throw new VulcanTransferCancelledError(); };

  if (!silent) emitTransfer({ id: transferId, filename: file.name, direction: 'upload', preparing: true, percent: 0 });
  try {
    assertNotCancelled();
    const started = await wsRequest('attachment/upload/start', {
      chat_id: chatId,
      filename: file.name,
      size: file.size,
      ...(options.workspacePath ? { workspace_path: options.workspacePath } : {}),
      ...(options.library ? { library: true } : {}),
    });
    uploadId = started.upload_id as string;
    assertNotCancelled();
    if (!silent) emitTransfer({ id: transferId, filename: file.name, direction: 'upload', preparing: false, percent: file.size === 0 ? 100 : 0 });

    const chunkSize = 384 * 1024;
    let acknowledged = 0;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      assertNotCancelled();
      const buffer = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 0x8000) {
        binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      }
      const ack = await wsRequest('attachment/upload/chunk', { upload_id: uploadId, data: btoa(binary) });
      assertNotCancelled();
      acknowledged = Number(ack.received ?? Math.min(file.size, offset + buffer.length));
      if (!silent) emitTransfer({
        id: transferId,
        filename: file.name,
        direction: 'upload',
        preparing: false,
        percent: file.size > 0 ? Math.min(100, (acknowledged / file.size) * 100) : 100,
      });
    }

    assertNotCancelled();
    const finished = await wsRequest('attachment/upload/finish', { upload_id: uploadId });
    uploadId = null;
    assertNotCancelled();
    removeProgress();
    if (!silent) emitTransferComplete({ id: transferId, filename: file.name, direction: 'upload' });
    return finished.path as string;
  } catch (error) {
    if (uploadId) await wsRequest('attachment/upload/cancel', { upload_id: uploadId }).catch(() => {});
    removeProgress();
    if (cancelled && !isTransferCancelledError(error)) throw new VulcanTransferCancelledError();
    throw error;
  } finally {
    activeUploadCancels.delete(transferId);
  }
}

export async function uploadAttachment(chatId: string, file: File, options: Omit<UploadOptions, 'workspacePath'> = {}): Promise<string> {
  return uploadFileBytes(chatId, file, options);
}

export async function uploadWorkspaceFile(chatId: string, file: File, path: string, options: Omit<UploadOptions, 'workspacePath'> = {}): Promise<string> {
  return uploadFileBytes(chatId, file, { ...options, workspacePath: path });
}

export async function uploadLibraryFile(file: File, options: Omit<UploadOptions, 'workspacePath' | 'library'> = {}): Promise<string> {
  return uploadFileBytes('', file, { ...options, library: true });
}


// ── Dashboards ────────────────────────────────────────────────────────────────

export async function dashboardCreate(chatId: string, name: string, html: string, css = '', js = ''): Promise<void> {
  await wsRequest('dashboard/create', { chat_id: chatId, name, html, css, js });
}

export async function dashboardUpdate(chatId: string, name: string, part: 'html' | 'css' | 'js', content: string): Promise<void> {
  await wsRequest('dashboard/update', { chat_id: chatId, name, part, content });
}

export async function dashboardInspect(chatId: string, name: string, part: 'html' | 'css' | 'js'): Promise<string> {
  const data = await wsRequest('dashboard/inspect', { chat_id: chatId, name, part });
  return data.content ?? '';
}

export async function dashboardList(chatId: string): Promise<{ name: string; updatedAt: string }[]> {
  const data = await wsRequest('dashboard/list', { chat_id: chatId });
  return data.dashboards ?? [];
}

export async function dashboardGet(chatId: string, name: string): Promise<string> {
  const data = await wsRequest('dashboard/get', { chat_id: chatId, name });
  return data.html ?? '';
}

export async function dashboardDelete(chatId: string, name: string): Promise<void> {
  await wsRequest('dashboard/delete', { chat_id: chatId, name });
}

// Kept for legacy compat — not used
export function streamTerminalOutput(_pid: string, _onLine: (l: string) => void, _onDone: () => void): () => void {
  return () => {};
}

// ── Terminal slots ────────────────────────────────────────────────────────────

export type SlotKind = 'agent' | 'user';

export interface SlotInfo {
  kind: SlotKind;
  slot: number;
  finished: boolean;
  has_running: boolean;
  last_activity: number;
}

export async function listSlots(chatId: string): Promise<SlotInfo[]> {
  const data = await wsRequest('terminal/slots', { chat_id: chatId });
  return data.slots ?? [];
}

export interface ChatTerminalStatus {
  userOpen: boolean;
  userBusy: boolean;
  agentOpen: boolean;
  agentBusy: boolean;
}

export async function listTerminalChatStatuses(): Promise<Record<string, ChatTerminalStatus>> {
  const data = await wsRequest('terminal/active-chats', {});
  const raw = data.statuses ?? {};
  return Object.fromEntries(Object.entries(raw).map(([chatId, status]: [string, any]) => [chatId, {
    userOpen: Boolean(status?.user_open),
    userBusy: Boolean(status?.user_busy),
    agentOpen: Boolean(status?.agent_open),
    agentBusy: Boolean(status?.agent_busy),
  }]));
}

export async function listActiveTerminalChats(): Promise<string[]> {
  const data = await wsRequest('terminal/active-chats', {});
  return data.chat_ids ?? [];
}

export async function openSlot(chatId: string, kind: SlotKind, slot?: number): Promise<number> {
  const data = await wsRequest('terminal/slot/open', {
    chat_id: chatId,
    kind,
    ...(slot === undefined ? {} : { slot }),
  });
  return data.slot;
}

export async function closeSlot(chatId: string, kind: SlotKind, slot: number): Promise<void> {
  await wsRequest('terminal/slot/close', { chat_id: chatId, kind, slot });
}

/** Returns the WebSocket URL for a terminal slot — used by TerminalSlotWidget directly */
export function slotStreamUrl(chatId: string, kind: SlotKind, slot: number): string {
  return `${getVulcanWsBaseUrl()}/ws/terminal/${encodeURIComponent(chatId)}/${kind}/${slot}`;
}

export async function readSlotOutput(chatId: string, kind: SlotKind, slot: number, lines = 50): Promise<string> {
  const data = await wsRequest('terminal/slot/output', { chat_id: chatId, kind, slot, lines });
  return data.output ?? '';
}

export async function runCommandInSlot(chatId: string, kind: SlotKind, slot: number, cmd: string, timeout: number | null = 180): Promise<string> {
  const data = await wsRequest('terminal/slot/run', { chat_id: chatId, kind, slot, cmd, timeout });
  return data.pid;
}

export async function getSlotScrollback(chatId: string, kind: SlotKind, slot: number): Promise<string | null> {
  try {
    const data = await wsRequest('terminal/slot/scrollback', { chat_id: chatId, kind, slot });
    return data.scrollback ?? null;
  } catch {
    return null;
  }
}

export async function saveSlotScrollback(chatId: string, kind: SlotKind, slot: number, scrollback: string): Promise<void> {
  // Scrollback is now saved server-side automatically — this is a no-op
  // but kept for API compatibility with TerminalSlotWidget
}

export async function sendSlotInput(chatId: string, kind: SlotKind, slot: number, text: string): Promise<boolean> {
  const data = await wsRequest('terminal/slot/input', { chat_id: chatId, kind, slot, text });
  return Boolean(data.ok);
}

export async function sendSlotAction(
  chatId: string,
  kind: SlotKind,
  slot: number,
  action: { text?: string; key?: string; modifiers?: string[]; submit?: boolean },
): Promise<boolean> {
  const data = await wsRequest('terminal/slot/input', { chat_id: chatId, kind, slot, ...action });
  return Boolean(data.ok);
}

export async function resizeSlot(chatId: string, kind: SlotKind, slot: number, cols: number, rows: number): Promise<void> {
  // Resize goes directly over the terminal WS — this REST path is not used
}

// ── Blob store (SSH target encrypted blobs) ───────────────────────────────────

export async function blobStore(id: string, data: string): Promise<void> {
  await wsRequest('blobs/store', { id, data });
}

export async function blobGet(id: string): Promise<string> {
  const result = await wsRequest('blobs/get', { id });
  return result.data;
}

export async function blobList(): Promise<string[]> {
  const result = await wsRequest('blobs/list', {});
  return result.ids ?? [];
}

export async function blobDelete(id: string): Promise<void> {
  await wsRequest('blobs/delete', { id });
}
