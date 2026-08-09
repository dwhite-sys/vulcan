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
import type { LLMConfig, ProviderConfig } from './llm';
import {
  remoteLoadChats,
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
  providers:     'vulcan:providers',
  vulcanEndpoint:'vulcan:endpoint',
} as const;

// ── Vulcan Settings ─────────────────────────────────────────────────────────

export interface VulcanSettings {
  cliWorkspaceEnabled: boolean;
  toolMode: 'broad' | 'search';
  panelsEnabled: boolean;
}

const DEFAULT_VULCAN_SETTINGS: VulcanSettings = {
  cliWorkspaceEnabled: true,
  toolMode: 'search',
  panelsEnabled: true,
};

export function loadVulcanSettings(): VulcanSettings {
  return { ...DEFAULT_VULCAN_SETTINGS, ...load<Partial<VulcanSettings>>(KEYS.settings) };
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

export function loadProviders(): ProviderConfig[] {
  const stored = load<ProviderConfig[]>(KEYS.providers);
  // An empty array is a valid saved registry (for example after deleting the last provider).
  if (stored !== null) return stored;

  // One-time migration from the legacy single inference endpoint.
  const legacy = load<Partial<LLMConfig>>(KEYS.llmConfig);
  if (legacy?.baseUrl) {
    const migrated: ProviderConfig[] = [{
      id: 'legacy-provider',
      name: 'Default Provider',
      baseUrl: legacy.baseUrl,
      apiKey: legacy.apiKey ?? '',
    }];
    save(KEYS.providers, migrated);
    return migrated;
  }
  return [];
}

export function saveProviders(providers: ProviderConfig[]): boolean {
  const saved = save(KEYS.providers, providers);
  if (saved && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('vulcan:providers-changed'));
  }
  return saved;
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
  return load<Partial<LLMConfig>>(KEYS.llmConfig) ?? {};
}

export function saveLLMConfig(config: LLMConfig) {
  save(KEYS.llmConfig, config);
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
  return load<string>(KEYS.selectedModel);
}

export function saveSelectedModel(model: string) {
  save(KEYS.selectedModel, model);
}

// ── Chats ─────────────────────────────────────────────────────────────────────
// All chat persistence goes through the Vulcan server. No localStorage fallback.

function rehydrateChat(c: Chat): Chat {
  return {
    ...c,
    createdAt: new Date(c.createdAt),
    updatedAt: new Date(c.updatedAt),
    messages: c.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })),
  };
}

export async function loadChats(): Promise<Chat[]> {
  const raw = await remoteLoadChats();
  return raw.map(rehydrateChat);
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
