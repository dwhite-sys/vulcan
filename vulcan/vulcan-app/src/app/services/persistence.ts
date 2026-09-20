/**
 * persistence.ts — localStorage-backed store for client config.
 *
 * Keys:
 *   vulcan:llm_config      — { baseUrl, apiKey, model }
 *   vulcan:server_url      — string (kit server URL)
 *   vulcan:selected_model  — string
 *   vulcan:settings        — VulcanSettings
 *
 * Chat persistence:
 *   All chats are stored on and loaded from the Vulcan server — no localStorage.
 */

import type { Chat, ChatFolder } from '../types/vulcan';
import { rehydrateChatEvents } from './transcript';
import type { LLMConfig, ProviderConfig } from './llm';
import { migrateScopedNetworkValue, scopedNetworkKey } from './networkProfileScope';
import {
  remoteLoadChats,
  remoteLoadChat,
  remoteSaveChat,
  remoteDeleteChat,
  remoteLoadChatFolders,
  remoteSaveChatFolders,
} from './vulcan';

const KEYS = {
  llmConfig:     'vulcan:llm_config',
  serverUrl:     'vulcan:server_url',
  selectedModel: 'vulcan:selected_model',
  settings:      'vulcan:settings',
  vulcanEndpoint:'vulcan:endpoint',
} as const;

// ── Vulcan Settings ─────────────────────────────────────────────────────────

export interface VulcanSettings {
  cliWorkspaceEnabled: boolean;
  recallEnabled: boolean;
  libraryEnabled: boolean;
  toolMode: 'broad' | 'search';
  discoveryExecution: 'wrapper' | 'promotion' | 'search-inspect';
  panelsEnabled: boolean;
  disabledVulcanSkills: string[];
}

const DEFAULT_VULCAN_SETTINGS: VulcanSettings = {
  cliWorkspaceEnabled: true,
  recallEnabled: true,
  libraryEnabled: true,
  // Search is the default: keep Etna schemas out of the prompt until discovered.
  // search-inspect keeps discovery itself search-led and promotes inspected tools directly.
  toolMode: 'search',
  discoveryExecution: 'search-inspect',
  panelsEnabled: true,
  disabledVulcanSkills: [],
};

export function loadVulcanSettings(): VulcanSettings {
  // Drop the short-lived global networking POV setting. Networking POV belongs
  // to individual provider/Etna entries, not to Vulcan settings as a whole.
  const stored = load<Partial<VulcanSettings> & { networkPointOfView?: unknown }>(KEYS.settings) ?? {};
  const { networkPointOfView: _legacyNetworkPointOfView, ...currentSettings } = stored;
  const settings = { ...DEFAULT_VULCAN_SETTINGS, ...currentSettings };
  settings.discoveryExecution = ['wrapper', 'promotion', 'search-inspect'].includes(settings.discoveryExecution)
    ? settings.discoveryExecution
    : DEFAULT_VULCAN_SETTINGS.discoveryExecution;
  settings.disabledVulcanSkills = Array.isArray(settings.disabledVulcanSkills)
    ? settings.disabledVulcanSkills.filter((skill): skill is string => typeof skill === 'string')
    : [];
  return settings;
}

export function saveVulcanSettings(settings: VulcanSettings) {
  save(KEYS.settings, settings);
}

// ── Default kit/tool settings (template for new chats, per server URL) ────────

function defaultEnabledKitsKey(serverUrl: string): string {
  return `vulcan:default_enabled_kits:${serverUrl.replace(/\/$/, '')}`;
}

function defaultDisabledToolsKey(serverUrl: string): string {
  return `vulcan:default_disabled_tools:${serverUrl.replace(/\/$/, '')}`;
}

export function loadDefaultEnabledKits(serverUrl: string): string[] | null {
  return load<string[]>(defaultEnabledKitsKey(serverUrl));
}

export function saveDefaultEnabledKits(serverUrl: string, kits: string[]) {
  save(defaultEnabledKitsKey(serverUrl), kits);
}

export function loadDefaultDisabledTools(serverUrl: string): Set<string> {
  const raw = load<string[]>(defaultDisabledToolsKey(serverUrl));
  return raw ? new Set(raw) : new Set();
}

export function saveDefaultDisabledTools(serverUrl: string, disabled: Set<string>) {
  save(defaultDisabledToolsKey(serverUrl), Array.from(disabled));
}

// ── Legacy: global disabled kits (kept for backwards compat, superseded by per-chat) ──

function disabledKitsKey(serverUrl: string): string {
  return `vulcan:disabled_kits:${serverUrl.replace(/\/$/, '')}`;
}

export function loadDisabledKits(serverUrl: string): Set<string> {
  const raw = load<string[]>(disabledKitsKey(serverUrl));
  return raw ? new Set(raw) : new Set();
}

export function saveDisabledKits(serverUrl: string, disabled: Set<string>) {
  save(disabledKitsKey(serverUrl), Array.from(disabled));
}

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`[Vulcan persistence] Failed to save ${key}`, error);
    return false;
  }
}


// ── Provider registry ───────────────────────────────────────────────────────

// Provider definitions are client-owned. CLIENT/SERVER is execution POV only;
// it never changes where the definition itself is persisted.
const PROVIDERS_KEY = 'vulcan:providers';

export function loadProviders(): ProviderConfig[] {
  const raw = migrateScopedNetworkValue(PROVIDERS_KEY);
  let providers: ProviderConfig[] = [];
  try { providers = raw ? JSON.parse(raw) as ProviderConfig[] : []; } catch { providers = []; }
  if (!Array.isArray(providers)) providers = [];
  return providers.map((provider) => ({
    ...provider,
    networkPointOfView: provider.networkPointOfView === 'server' ? 'server' : 'client',
    apiKey: provider.apiKey ?? '',
  }));
}

function publishProviders() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vulcan:providers-changed'));
}

/** Backward-compatible no-op: provider state is no longer hydrated from Vulcan servers. */
export function cacheServerProviders(_providers: ProviderConfig[]): boolean { return true; }

export async function saveProviders(providers: ProviderConfig[]): Promise<boolean> {
  const normalized = providers.map((provider) => ({
    ...provider,
    networkPointOfView: provider.networkPointOfView === 'server' ? 'server' as const : 'client' as const,
  }));
  const ok = save(scopedNetworkKey(PROVIDERS_KEY), normalized);
  if (ok) publishProviders();
  return ok;
}

// ── Vulcan endpoint ─────────────────────────────────────────────────────────

export function loadVulcanEndpoint(): string {
  return load<string>(KEYS.vulcanEndpoint) ?? 'http://localhost:8468';
}

export function saveVulcanEndpoint(url: string) {
  save(KEYS.vulcanEndpoint, url);
}

// ── LLM Config ────────────────────────────────────────────────────────────────

export function loadLLMConfig(): Partial<LLMConfig> {
  const key = scopedNetworkKey(KEYS.llmConfig);
  const raw = migrateScopedNetworkValue(KEYS.llmConfig);
  let config: Partial<LLMConfig> = {};
  try { config = raw ? JSON.parse(raw) as Partial<LLMConfig> : {}; } catch { config = {}; }
  if (config.apiKey) save(key, { ...config, apiKey: '' });
  return { ...config, apiKey: '' };
}

export function saveLLMConfig(config: LLMConfig) {
  save(scopedNetworkKey(KEYS.llmConfig), { ...config, apiKey: '' });
}

// ── Server URL ────────────────────────────────────────────────────────────────

export function loadServerUrl(): string | null {
  return load<string>(KEYS.serverUrl);
}

export function saveServerUrl(url: string) {
  save(KEYS.serverUrl, url);
}

// ── Selected Model ────────────────────────────────────────────────────────────

export function loadSelectedModel(): string | null {
  const raw = migrateScopedNetworkValue(KEYS.selectedModel);
  try { return raw ? JSON.parse(raw) as string : null; } catch { return null; }
}

export function saveSelectedModel(model: string) {
  save(scopedNetworkKey(KEYS.selectedModel), model);
}


const DISABLED_ETNA_SKILLS_KEY = 'vulcan:disabled_etna_skills';

export function loadDisabledEtnaSkills(): Set<string> {
  const raw = migrateScopedNetworkValue(DISABLED_ETNA_SKILLS_KEY);
  try {
    const values = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveDisabledEtnaSkills(disabled: Set<string>): boolean {
  return save(scopedNetworkKey(DISABLED_ETNA_SKILLS_KEY), Array.from(disabled));
}

// ── Chats ─────────────────────────────────────────────────────────────────────
// All chat persistence goes through the Vulcan server. No localStorage fallback.

function rehydrateChat(c: Chat): Chat {
  const rawBranching = (c as any).branching;
  const branching = rawBranching?.version === 1 && Array.isArray(rawBranching.branches) && Array.isArray(rawBranching.nodes)
    ? {
        ...rawBranching,
        nodes: rawBranching.nodes.map((node: any) => ({
          ...node,
          event: rehydrateChatEvents([node.event], true)[0],
        })).filter((node: any) => Boolean(node.event)),
        branches: rawBranching.branches.map((branch: any) => ({
          ...branch,
          createdAt: new Date(branch.createdAt),
          updatedAt: new Date(branch.updatedAt),
        })),
      }
    : undefined;
  return {
    ...c,
    schemaVersion: 2,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
    // v85+ canonical transcript: the persisted ordered event stream is exactly
    // what the renderer consumes. Old development chats are intentionally not
    // reconstructed heuristically; unreleased builds may simply start fresh. A
    // process restart turns an unfinished streaming/running event into interrupted
    // without discarding any content or changing its position.
    events: rehydrateChatEvents((c as any).events, true),
    ...(branching ? { branching } : {}),
    ...(() => {
      const rawDesigns = Array.isArray((c as any).designs)
        ? (c as any).designs
        : (((c as any).design?.version === 1 || (c as any).livePane?.version === 1)
            ? [(c as any).design ?? (c as any).livePane]
            : []);
      if (!rawDesigns.length) return {};
      return {
        designs: rawDesigns
          .filter((item: any) => item?.version === 1 && item?.url)
          .map((item: any) => ({
            version: 1 as const,
            id: String(item.id),
            name: String(item.name ?? item.title ?? 'Design'),
            url: String(item.url),
            attachedAt: new Date(item.attachedAt),
            updatedAt: new Date(item.updatedAt ?? item.attachedAt),
          })),
      };
    })(),
  };
}

export async function loadChats(): Promise<Chat[]> {
  const raw = await remoteLoadChats();

  // v85+ is intentionally a hard schema break. Do not turn an old chat into an
  // apparently valid empty v2 chat: that makes selecting it look exactly like
  // the New Chat screen even though handleSelectChat actually succeeded.
  // Incompatible development chats are simply omitted from the sidebar.
  return raw
    .filter((chat: any) => chat?.schemaVersion === 2 && Array.isArray(chat?.events))
    .map(rehydrateChat);
}

export async function loadChat(chatId: string): Promise<Chat | null> {
  const raw = await remoteLoadChat(chatId);
  if (!raw || raw?.schemaVersion !== 2 || !Array.isArray(raw?.events)) return null;
  const hydrated = rehydrateChat(raw as Chat);
  delete (hydrated as any)._summaryOnly;
  return hydrated;
}

export async function saveChat(chat: Chat): Promise<void> {
  await remoteSaveChat(chat);
}

export async function deleteChat(chatId: string): Promise<void> {
  await remoteDeleteChat(chatId);
}


// ── Chat folders ──────────────────────────────────────────────────────────────

export async function loadChatFolders(): Promise<ChatFolder[]> {
  const raw = await remoteLoadChatFolders();
  return raw.map((f: any) => ({ ...f, createdAt: new Date(f.createdAt) }));
}

export async function saveChatFolders(folders: ChatFolder[]): Promise<void> {
  await remoteSaveChatFolders(folders);
}
