import { useState, useEffect, useCallback, useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { TopBar } from './components/TopBar';
import { KitSidebar, type SidebarDragItem } from './components/KitSidebar';
import { ChatInterface } from './components/ChatInterface';
import type { SkillMeta } from './components/SkillToggleMenu';
import { WorkspacePanel } from './components/WorkspacePanel';
import { HarnessTrustDialog } from './components/HarnessTrustDialog';
import { ServerPasswordDialog } from './components/ServerPasswordDialog';
import { vulcanClient as etnaClient } from './services/vulcanClient';
import { llmClient, testProviderConnection, type LLMConfig, type ProviderConfig } from './services/llm';
import { getVulcanTools, isVulcanTool, executeVulcanTool } from './services/vulcanTools';
import { getActiveBuiltinSkills } from './skills/builtins';
import * as vulcan from './services/vulcan';
import {
  loadLLMConfig, saveLLMConfig,
  loadServerUrl, saveServerUrl,
  loadSelectedModel, saveSelectedModel,
  loadChats, saveChat, deleteChat, loadChatFolders, saveChatFolders,
  loadDefaultEnabledKits, saveDefaultEnabledKits,
  loadDefaultDisabledTools, saveDefaultDisabledTools,
  loadVulcanSettings, saveVulcanSettings,
  loadProviders,
  type VulcanSettings,
} from './services/persistence';
import { savePanel, deleteChatPanels } from './services/panelCache';
import type { Kit, KitWithTools, Message, Chat, ChatFolder, Tool, PresentedFile, MessageAttachment, Panel as PanelMeta, TerminalSlotMeta, SlotKind, UserQuestionBatch, UserQuestionAnswer } from './types/vulcan';
import { toast, Toaster } from 'sonner';
import { ChevronDown, ChevronRight } from 'lucide-react';

export default function App() {
  const [serverUrl, setServerUrl] = useState(() => loadServerUrl() ?? 'http://localhost:8467');
  const [connected, setConnected] = useState(false);
  const [providerConnectionState, setProviderConnectionState] = useState<'none' | 'partial' | 'all'>('none');
  const [artifactsPanelOpen, setArtifactsPanelOpen] = useState(false);
  const [presentedFiles, setPresentedFiles] = useState<PresentedFile[]>([]);
  const [presentedFilePath, setPresentedFilePath] = useState<string | null>(null);
  const [openPanelName, setOpenPanelName] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelMeta[]>([]);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [vulcanSettings, setVulcanSettings] = useState<VulcanSettings>(() => loadVulcanSettings());
  const [terminalSlots, setTerminalSlots] = useState<TerminalSlotMeta[]>([]);
  const [terminalChatStatuses, setTerminalChatStatuses] = useState<Record<string, vulcan.ChatTerminalStatus>>({});
  const [activeTerminalSlot, setActiveTerminalSlot] = useState<TerminalSlotMeta | null>(null);
  const [focusedAgentSlot, setFocusedAgentSlot] = useState<number | null>(null);
  // Refs provide synchronous terminal state to multi-tool inference loops. React state
  // updates are asynchronous, so open_terminal -> switch_terminal -> run_command
  // in a single assistant turn must not rely on a stale render snapshot.
  const focusedAgentSlotRef = useRef<number | null>(null);
  const openAgentSlotsRef = useRef<number[]>([]);
  const [agentRunningSlot, setAgentRunningSlot] = useState<{ kind: SlotKind; slot: number } | null>(null);
  const renderWidthRef = useRef<number>(680);
  const [kits, setKits] = useState<Kit[]>([]);
  const [kitsWithTools, setKitsWithTools] = useState<KitWithTools[]>([]);
  // kitToolsCache: populated once per connection, used to derive kitsWithTools without re-fetching
  const kitToolsCacheRef = useRef<KitWithTools[]>([]);
  const [kitsLoaded, setKitsLoaded] = useState(false);
  const [skills, setSkills] = useState<SkillMeta[]>([]);

  // Chats — loaded async from server on mount; pendingChat is in-memory only
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatFolders, setChatFolders] = useState<ChatFolder[]>([]);
  const [pendingChat, setPendingChat] = useState<Chat | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);

  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [questionBatch, setQuestionBatch] = useState<UserQuestionBatch | null>(null);
  const questionResolverRef = useRef<((answers: Record<string, UserQuestionAnswer>) => void) | null>(null);

  const resolveQuestionBatch = useCallback((answers: Record<string, UserQuestionAnswer>) => {
    const resolver = questionResolverRef.current;
    questionResolverRef.current = null;
    setQuestionBatch(null);
    resolver?.(answers);
  }, []);

  const awaitQuestionBatch = useCallback((batch: UserQuestionBatch, signal: AbortSignal) => {
    return new Promise<Record<string, UserQuestionAnswer>>((resolve, reject) => {
      const onAbort = () => {
        questionResolverRef.current = null;
        setQuestionBatch(null);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      questionResolverRef.current = (answers) => {
        signal.removeEventListener('abort', onAbort);
        resolve(answers);
      };
      setQuestionBatch(batch);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }, []);

  const [llmConfig, setLLMConfig] = useState<LLMConfig>(() => {
    const saved = loadLLMConfig();
    const providers = loadProviders();
    const provider = providers.find((p) => p.id === saved.providerId) ?? providers[0];
    const config = {
      baseUrl: provider?.baseUrl ?? '',
      apiKey: provider?.apiKey ?? '',
      model: saved.model ?? '',
      providerId: provider?.id,
      ...saved,
    };
    if (provider && saved.providerId) {
      config.baseUrl = provider.baseUrl;
      config.apiKey = provider.apiKey;
    }
    llmClient.setConfig(config);
    return config;
  });
  const [selectedModel, setSelectedModel] = useState(() => loadSelectedModel() ?? '');

  // Per-chat kit/tool state — derived from activeChat, falling back to defaults
  const getActiveChatEnabledKits = (chat: Chat | null): string[] => {
    if (!chat) return kits.filter((k) => k.enabled).map((k) => k.kit_name);
    return chat.enabledKits ?? kits.filter((k) => k.enabled).map((k) => k.kit_name);
  };

  const getActiveChatDisabledTools = (chat: Chat | null): Set<string> => {
    if (!chat) return loadDefaultDisabledTools(serverUrl);
    return new Set(chat.disabledTools ?? []);
  };

  // Convenience derived values for the active chat
  const enabledKits = getActiveChatEnabledKits(activeChat);
  const disabledTools = getActiveChatDisabledTools(activeChat);

  // Sidebar collapsed state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  // Global Container sidebar is intentionally closed on every app launch.
  // Only its expanded height persists across closes/restarts.
  const [globalSectionExpanded, setGlobalSectionExpanded] = useState(false);
  const [globalSectionHeight, setGlobalSectionHeight] = useState(() => {
    const saved = Number(localStorage.getItem('vulcan:global_section_height'));
    return Number.isFinite(saved) && saved >= 140 ? saved : 220;
  });
  const globalResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // AbortController for cancelling in-flight inference
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  // Keep sidebar terminal activity indicators in sync for every chat, including
  // background chats whose PTYs may auto-close while another conversation is open.
  useEffect(() => {
    if (!connected) {
      setTerminalChatStatuses({});
      return;
    }

    let cancelled = false;
    const refresh = async () => {
      try {
        const statuses = await vulcan.listTerminalChatStatuses();
        if (!cancelled) setTerminalChatStatuses(statuses);
      } catch {
        // Connection state/toasts are handled elsewhere; a transient poll failure
        // should not interrupt the chat UI.
      }
    };

    refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [connected]);

  // ── Terminal slot handlers ────────────────────────────────────────────────

  const handleOpenAgentSlot = useCallback(async (): Promise<number> => {
    if (!activeChat) throw new Error('No active chat');
    const slot = await vulcan.openSlot(activeChat.id, 'agent');
    const meta: TerminalSlotMeta = { kind: 'agent', slot, chatId: activeChat.id, status: 'connected' };
    setTerminalSlots((prev) => [...prev.filter((s) => !(s.kind === 'agent' && s.slot === slot)), meta]);
    openAgentSlotsRef.current = [...new Set([...openAgentSlotsRef.current, slot])].sort((a, b) => a - b);
    setActiveTerminalSlot(meta);
    return slot;
  }, [activeChat]);

  const handleCloseAgentSlot = useCallback((slot: number) => {
    if (!activeChat) return;
    vulcan.closeSlot(activeChat.id, 'agent', slot).catch(() => {});
    setTerminalSlots((prev) => prev.filter((s) => !(s.kind === 'agent' && s.slot === slot)));
    openAgentSlotsRef.current = openAgentSlotsRef.current.filter((s) => s !== slot);
    if (focusedAgentSlotRef.current === slot) focusedAgentSlotRef.current = null;
    setFocusedAgentSlot((current) => current === slot ? null : current);
    setActiveTerminalSlot((prev) => {
      if (prev?.kind === 'agent' && prev.slot === slot) {
        // Fall back to first remaining slot
        return terminalSlots.find((s) => !(s.kind === 'agent' && s.slot === slot)) ?? null;
      }
      return prev;
    });
  }, [activeChat, terminalSlots]);

  const handleSwitchAgentSlot = useCallback((slot: number) => {
    focusedAgentSlotRef.current = slot;
    setFocusedAgentSlot(slot);
    const meta = terminalSlots.find((s) => s.kind === 'agent' && s.slot === slot);
    if (meta) setActiveTerminalSlot(meta);
  }, [terminalSlots]);

  const handleOpenUserSlot = useCallback(async () => {
    if (!activeChat) return;
    try {
      const slot = await vulcan.openSlot(activeChat.id, 'user');
      const meta: TerminalSlotMeta = { kind: 'user', slot, chatId: activeChat.id, status: 'connected' };
      setTerminalSlots((prev) => [...prev.filter((s) => !(s.kind === 'user' && s.slot === slot)), meta]);
      setActiveTerminalSlot(meta);
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to open terminal');
    }
  }, [activeChat]);

  const handleCloseTerminalSlot = useCallback((slot: TerminalSlotMeta) => {
    if (!activeChat) return;
    vulcan.closeSlot(activeChat.id, slot.kind, slot.slot).catch(() => {});
    if (slot.kind === 'agent') {
      openAgentSlotsRef.current = openAgentSlotsRef.current.filter((s) => s !== slot.slot);
      if (focusedAgentSlotRef.current === slot.slot) {
        focusedAgentSlotRef.current = null;
        setFocusedAgentSlot(null);
      }
    }
    setTerminalSlots((prev) => prev.filter((s) => !(s.kind === slot.kind && s.slot === slot.slot)));
    setActiveTerminalSlot((prev) =>
      prev?.kind === slot.kind && prev.slot === slot.slot ? null : prev
    );
  }, [activeChat]);

  const setAgentRunning = (pid: string, label: string) => {
    if (focusedAgentSlotRef.current !== null) {
      setAgentRunningSlot({ kind: 'agent', slot: focusedAgentSlotRef.current });
    }
  };

  const setAgentIdle = () => {
    setAgentRunningSlot(null);
  };

  // On committed-chat change: clear slots and load from Vulcan. A pending
  // new conversation has an in-memory ID but no workspace/container yet.
  const activeChatId = activeChat?.id ?? null;
  const workspaceChatId = activeChat && pendingChat?.id !== activeChat.id ? activeChat.id : null;

  useEffect(() => {
    setTerminalSlots([]);
    setActiveTerminalSlot(null);
    focusedAgentSlotRef.current = null;
    openAgentSlotsRef.current = [];
    setFocusedAgentSlot(null);
    setAgentRunningSlot(null);
    if (!workspaceChatId || !vulcanSettings.cliWorkspaceEnabled) return;

    let cancelled = false;
    void (async () => {
      try {
        // A persisted chat may have an existing but stopped container. Start it
        // before inspecting/restoring terminal slots so docker exec has a live
        // target. Pending chats never reach this effect because workspaceChatId
        // is null until the conversation is committed.
        await vulcan.ensureContainer(workspaceChatId);
        if (cancelled) return;

        const slots = await vulcan.listSlots(workspaceChatId);
        if (cancelled) return;
        const metas: TerminalSlotMeta[] = slots.map((s) => ({
          kind: s.kind as SlotKind,
          slot: s.slot,
          chatId: workspaceChatId,
          status: s.finished ? 'disconnected' : 'connected',
        }));
        setTerminalSlots(metas);
        openAgentSlotsRef.current = metas.filter((s) => s.kind === 'agent').map((s) => s.slot);
        // Default active slot: first agent slot, or first user slot, or null
        const firstAgent = metas.find((s) => s.kind === 'agent');
        const firstUser  = metas.find((s) => s.kind === 'user');
        const first = firstAgent ?? firstUser ?? null;
        setActiveTerminalSlot(first);

        // No slots at all → auto-open a user terminal so there's always one ready
        if (metas.length === 0) {
          const slot = await vulcan.openSlot(workspaceChatId, 'user');
          if (cancelled) return;
          const meta: TerminalSlotMeta = { kind: 'user', slot, chatId: workspaceChatId, status: 'connected' };
          setTerminalSlots([meta]);
          setActiveTerminalSlot(meta);
        }
      } catch (e) {
        console.warn('Failed to restore workspace terminal:', e);
      }
    })();

    return () => { cancelled = true; };
  }, [workspaceChatId, vulcanSettings.cliWorkspaceEnabled]);

  const updateChatDisabledTools = (updater: (prev: Set<string>) => Set<string>) => {
    if (!activeChat) return;
    const prev = getActiveChatDisabledTools(activeChat);
    const next = updater(prev);
    const nextArray = Array.from(next);
    // Save as default for future chats
    saveDefaultDisabledTools(serverUrl, next);
    // Update the active chat
    const updateChat = (c: Chat) => c.id === activeChat.id ? { ...c, disabledTools: nextArray } : c;
    if (pendingChat?.id === activeChat.id) {
      setPendingChat((p) => p ? { ...p, disabledTools: nextArray } : p);
    } else {
      setChats((prev) => prev.map(updateChat));
      const updated = updateChat(activeChat);
      saveChat(updated).catch((e) => console.warn('Failed to save chat disabledTools:', e));
    }
    setActiveChat((prev) => prev ? { ...prev, disabledTools: nextArray } : prev);
  };

  const toggleDisabledTool = (toolKey: string) => {
    updateChatDisabledTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolKey)) next.delete(toolKey);
      else next.add(toolKey);
      return next;
    });
  };

  const enableAllToolsInKit = (kitName: string) => {
    updateChatDisabledTools((prev) => {
      const next = new Set(prev);
      kitsWithTools
        .find((k) => k.kit_name === kitName)
        ?.tools.forEach((t) => next.delete(`${kitName}::${t.name}`));
      return next;
    });
  };

  // ── LLM config ────────────────────────────────────────────────────────────

  const handleLLMConfigChange = (partial: Partial<LLMConfig>) => {
    const next = { ...llmClient.getConfig(), ...partial } as LLMConfig;
    llmClient.setConfig(next);
    saveLLMConfig(next);
    setLLMConfig(next);
    // Re-test the newly applied provider/model config so the indicator stays accurate.
    void testInferenceConnection();
  };

  const handleSelectModel = (modelId: string, provider: ProviderConfig) => {
    setSelectedModel(modelId);
    handleLLMConfigChange({ model: modelId, providerId: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey });
    saveSelectedModel(modelId);
  };

  // ── Vulcan connection ───────────────────────────────────────────────────

  const testConnection = useCallback(async (candidateUrl?: string) => {
    try {
      if (candidateUrl) {
        const previous = serverUrl;
        etnaClient.setBaseUrl(candidateUrl);
        const success = await etnaClient.testConnection();
        etnaClient.setBaseUrl(previous);
        return success;
      }
      const success = await etnaClient.testConnection();
      setConnected(success);
      return success;
    } catch {
      setConnected(false);
      return false;
    }
  }, [serverUrl]);

  const testInferenceConnection = useCallback(async () => {
    const providers = loadProviders();
    if (providers.length === 0) {
      setProviderConnectionState('none');
      return false;
    }

    const results = await Promise.all(providers.map((provider) => testProviderConnection(provider)));
    const connectedCount = results.filter(Boolean).length;
    setProviderConnectionState(connectedCount === providers.length ? 'all' : connectedCount > 0 ? 'partial' : 'none');
    return connectedCount > 0;
  }, []);

  const loadKits = useCallback(async () => {
    setLoading(true);
    try {
      const kitNames = await etnaClient.listKits();
      const kitDetails = await Promise.all(kitNames.map((name) => etnaClient.inspectKit(name)));
      setKits(kitDetails);
      setConnected(true);
      toast.success(`Loaded ${kitDetails.length} kits`);

      // Load general skills from server
      try {
        const skillsData = await etnaClient.listSkills();
        // The per-chat Skills toggle controls standalone Etna skills only.
        // Kit-paired skills are governed by their kit toggle and discovered through
        // the same unified skill protocol at execution time.
        setSkills(skillsData
          .filter((s) => s.source === 'skills')
          .map((s) => ({
            name: s.name,
            stem: s.name.toLowerCase().replace(/\s+/g, '-'),
            description: s.description,
            source: s.source,
            enabled: true,
          })));
      } catch { /* skills are optional */ }
      return kitDetails;
    } catch {
      toast.error('Failed to load kits');
      setConnected(false);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTools = useCallback(async (allKits: Kit[]) => {
    try {
      const kitsWithToolsData = await Promise.all(
        allKits.map(async (kit) => {
          const { tools } = await etnaClient.listToolsInKit(kit.kit_name);
          return { ...kit, tools };
        })
      );
      kitToolsCacheRef.current = kitsWithToolsData;
      setKitsWithTools(kitsWithToolsData);
      setKitsLoaded(true);
    } catch {
      toast.error('Failed to load tools');
    }
  }, []);

  useEffect(() => {
    etnaClient.setBaseUrl(serverUrl);
    const init = async () => {
      const success = await testConnection();
      if (success) {
        const loadedKits = await loadKits();
        await loadTools(loadedKits);
      }
      await testInferenceConnection();
    };
    init();
  }, [serverUrl, testConnection, testInferenceConnection, loadKits, loadTools]);

  useEffect(() => {
    const refreshProviderStatus = () => { void testInferenceConnection(); };
    window.addEventListener('vulcan:providers-changed', refreshProviderStatus);
    const timer = window.setInterval(refreshProviderStatus, 5000);
    return () => {
      window.removeEventListener('vulcan:providers-changed', refreshProviderStatus);
      window.clearInterval(timer);
    };
  }, [testInferenceConnection]);

  // On mount, load chats from the Vulcan server.
  useEffect(() => {
    Promise.all([loadChats(), loadChatFolders()]).then(([loadedChats, loadedFolders]) => {
      setChats(loadedChats);
      setChatFolders(loadedFolders);
    }).catch(() => { /* server unreachable — sidebar remains empty until connected */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Chat management ────────────────────────────────────────────────────────

  // Create a new pending chat (not in sidebar yet)
  const handleNewChat = (global = false) => {
    // Only snapshot kit/tool defaults after kits have loaded — prevents the race
    // condition where the initial chat gets permanently pinned to an empty kit config
    const defaultEnabledKitNames = kitsLoaded
      ? (loadDefaultEnabledKits(serverUrl) ?? kits.filter((k) => k.enabled).map((k) => k.kit_name))
      : undefined;
    const defaultDisabledToolsArray = kitsLoaded
      ? Array.from(loadDefaultDisabledTools(serverUrl))
      : undefined;

    const newChat: Chat = {
      id: Date.now().toString(),
      title: '',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(global ? { containerScope: 'global' as const } : {}),
      ...(defaultEnabledKitNames !== undefined ? { enabledKits: defaultEnabledKitNames } : {}),
      ...(defaultDisabledToolsArray !== undefined ? { disabledTools: defaultDisabledToolsArray } : {}),
    };
    setPendingChat(newChat);
    setActiveChat(newChat);
    setPanels([]);
    setPresentedFiles([]);
    setAttachments([]);
  };

  // Always start on a fresh new chat screen on launch
  useEffect(() => {
    handleNewChat();
  }, []);

  // Listen for open-file events dispatched by the present() card's Open button
  useEffect(() => {
    const handler = (e: Event) => {
      const { path } = (e as CustomEvent).detail ?? {};
      if (path) {
        setPresentedFilePath(path);
        setArtifactsPanelOpen(true);
      }
    };
    window.addEventListener('vulcan:open-file', handler);
    return () => window.removeEventListener('vulcan:open-file', handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { name } = (e as CustomEvent).detail ?? {};
      if (name) {
        setOpenPanelName(name);
        setArtifactsPanelOpen(true);
      }
    };
    window.addEventListener('vulcan:open-panel', handler);
    return () => window.removeEventListener('vulcan:open-panel', handler);
  }, []);

  const handleSelectChat = (chatId: string) => {
    const chat = chats.find((c) => c.id === chatId);
    if (chat) {
      setActiveChat(chat);
      setPendingChat(null);
      // Restore presented files, deduplicating by path, latest wins
      const allRestored = chat.messages.flatMap((m) => m.presentedFiles ?? []);
      const restored = allRestored.reduce<PresentedFile[]>((acc, pf) => {
        const idx = acc.findIndex((f) => f.path === pf.path);
        if (idx === -1) return [...acc, pf];
        const next = [...acc];
        next[idx] = pf;
        return next;
      }, []);
      setPresentedFiles(restored);
      // Restore panels from Vulcan (source of truth) with message history as fallback
      vulcan.dashboardList(chatId).then((serverPanels) => {
        if (serverPanels.length > 0) {
          // Map server panels to PanelMeta, using message history to recover messageId
          const allMsgPanels = chat.messages.flatMap((m) => m.panels ?? []);
          const restored = serverPanels.map((sp) => {
            const found = allMsgPanels.find((p) => p.name === sp.name);
            return { name: sp.name, updatedAt: new Date(sp.updatedAt), messageId: found?.messageId ?? '' };
          });
          setPanels(restored);
        } else {
          // Fall back to message history if server has no panels (e.g. workspace not yet started)
          const allPanels = chat.messages.flatMap((m) => m.panels ?? []);
          const restoredPanels = allPanels.reduce<PanelMeta[]>((acc, p) => {
            const idx = acc.findIndex((x) => x.name === p.name);
            if (idx === -1) return [...acc, p];
            const next = [...acc];
            next[idx] = new Date(p.updatedAt) > new Date(next[idx].updatedAt) ? p : next[idx];
            return next;
          }, []);
          setPanels(restoredPanels);
        }
      }).catch(() => {
        // Vulcan unreachable — fall back to message history
        const allPanels = chat.messages.flatMap((m) => m.panels ?? []);
        const restoredPanels = allPanels.reduce<PanelMeta[]>((acc, p) => {
          const idx = acc.findIndex((x) => x.name === p.name);
          if (idx === -1) return [...acc, p];
          const next = [...acc];
          next[idx] = new Date(p.updatedAt) > new Date(next[idx].updatedAt) ? p : next[idx];
          return next;
        }, []);
        setPanels(restoredPanels);
      });
      setAttachments([]);
    }
  };

  const handleDeleteChat = (chatId: string) => {
    deleteChatPanels(chatId);
    setChats((prev) => {
      const filtered = prev.filter((c) => c.id !== chatId);
      if (activeChat?.id === chatId) {
        const next = filtered[0] || null;
        setActiveChat(next);
        if (!next) handleNewChat();
      }
      return filtered;
    });
    deleteChat(chatId).catch((e) => console.warn('Failed to delete chat remotely:', e));
    toast.success('Chat deleted');
  };

  const handleRenameChat = (chatId: string, title: string) => {
    let renamed: Chat | undefined;
    setChats((prev) => {
      const next = prev.map((c) => {
        if (c.id !== chatId) return c;
        renamed = { ...c, title, updatedAt: new Date() };
        return renamed;
      });
      return next;
    });
    if (activeChat?.id === chatId) {
      setActiveChat((prev) => (prev ? { ...prev, title } : null));
    }
    if (renamed) saveChat(renamed).catch((e) => console.warn('Failed to save renamed chat:', e));
    toast.success('Chat renamed');
  };

  const handleNewFolder = (global = false) => {
    const scope: 'chat' | 'global' = global ? 'global' : 'chat';
    const rootOrders = [
      ...chatFolders.filter((f) => (f.scope ?? 'chat') === scope && (f.parentId ?? null) === null).map((f) => f.sidebarOrder ?? -1),
      ...chats.filter((c) => (c.containerScope ?? 'chat') === scope && (c.folderId ?? null) === null).map((c) => c.sidebarOrder ?? -1),
    ];
    const folder: ChatFolder = {
      id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: 'New Folder',
      parentId: null,
      createdAt: new Date(),
      sidebarOrder: Math.max(-1, ...rootOrders) + 1,
      collapsed: false,
      ...(global ? { scope: 'global' as const } : {}),
    };
    const next = [...chatFolders, folder];
    setChatFolders(next);
    saveChatFolders(next).catch((e) => console.warn('Failed to save chat folders:', e));
  };

  const handleSetFolderCollapsed = (folderId: string, collapsed: boolean) => {
    const next = chatFolders.map((f) => f.id === folderId ? { ...f, collapsed } : f);
    setChatFolders(next);
    saveChatFolders(next).catch((e) => console.warn('Failed to save chat folder collapsed state:', e));
  };

  const handleRenameFolder = (folderId: string, name: string) => {
    const next = chatFolders.map((f) => f.id === folderId ? { ...f, name } : f);
    setChatFolders(next);
    saveChatFolders(next).catch((e) => console.warn('Failed to rename chat folder:', e));
  };

  const handleDeleteFolder = (folderId: string) => {
    const folder = chatFolders.find((f) => f.id === folderId);
    if (!folder) return;
    const parentId = folder.parentId ?? null;
    const promotedChats = chats.map((c) => (c.folderId ?? null) === folderId ? { ...c, folderId: parentId } : c);
    const nextFolders = chatFolders
      .filter((f) => f.id !== folderId)
      .map((f) => (f.parentId ?? null) === folderId ? { ...f, parentId } : f);
    setChats(promotedChats);
    setChatFolders(nextFolders);
    promotedChats.filter((c, i) => c !== chats[i]).forEach((c) => saveChat(c).catch((e) => console.warn('Failed to promote chat from deleted folder:', e)));
    saveChatFolders(nextFolders).catch((e) => console.warn('Failed to delete chat folder:', e));
    toast.success('Folder deleted');
  };

  const handleMoveSidebarItem = (scope: 'chat' | 'global', item: SidebarDragItem, parentFolderId: string | null, index: number, expandFolderId?: string) => {
    const itemScope = item.type === 'chat'
      ? (chats.find((c) => c.id === item.id)?.containerScope ?? 'chat')
      : (chatFolders.find((f) => f.id === item.id)?.scope ?? 'chat');
    if (itemScope !== scope) return;
    if (parentFolderId) {
      const parent = chatFolders.find((f) => f.id === parentFolderId);
      if (!parent || (parent.scope ?? 'chat') !== scope) return;
    }
    if (item.type === 'folder') {
      if (item.id === parentFolderId) return;
      let cursor = parentFolderId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        if (cursor === item.id) return;
        seen.add(cursor);
        cursor = chatFolders.find((f) => f.id === cursor)?.parentId ?? null;
      }
    }

    type Mixed = { type: 'chat' | 'folder'; id: string; order?: number; fallback: number };
    const sourceParentId = item.type === 'chat'
      ? (chats.find((c) => c.id === item.id)?.folderId ?? null)
      : (chatFolders.find((f) => f.id === item.id)?.parentId ?? null);

    const allTargetSiblings: Mixed[] = [];
    chatFolders.forEach((f, i) => {
      if ((f.scope ?? 'chat') === scope && (f.parentId ?? null) === parentFolderId) allTargetSiblings.push({ type: 'folder', id: f.id, order: f.sidebarOrder, fallback: i });
    });
    chats.forEach((c, i) => {
      if ((c.containerScope ?? 'chat') === scope && (c.folderId ?? null) === parentFolderId) allTargetSiblings.push({ type: 'chat', id: c.id, order: c.sidebarOrder, fallback: i });
    });
    allTargetSiblings.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.fallback - b.fallback);
    const oldTargetIndex = allTargetSiblings.findIndex((entry) => entry.type === item.type && entry.id === item.id);
    const siblings = allTargetSiblings.filter((entry) => !(entry.type === item.type && entry.id === item.id));
    let adjustedIndex = index;
    if (sourceParentId === parentFolderId && oldTargetIndex >= 0 && oldTargetIndex < index) adjustedIndex -= 1;
    const insertAt = Math.max(0, Math.min(adjustedIndex, siblings.length));
    siblings.splice(insertAt, 0, { type: item.type, id: item.id, fallback: -1 });

    const orderMap = new Map(siblings.map((entry, i) => [`${entry.type}:${entry.id}`, i]));
    const nextChats = chats.map((c) => {
      const key = `chat:${c.id}`;
      if (item.type === 'chat' && c.id === item.id) return { ...c, folderId: parentFolderId, sidebarOrder: orderMap.get(key) ?? 0 };
      const order = orderMap.get(key);
      return order === undefined ? c : { ...c, sidebarOrder: order };
    });
    const nextFolders = chatFolders.map((f) => {
      const key = `folder:${f.id}`;
      const order = orderMap.get(key);
      let nextFolder = f;
      if (item.type === 'folder' && f.id === item.id) nextFolder = { ...nextFolder, parentId: parentFolderId, sidebarOrder: order ?? 0 };
      else if (order !== undefined) nextFolder = { ...nextFolder, sidebarOrder: order };
      if (expandFolderId && f.id === expandFolderId) nextFolder = { ...nextFolder, collapsed: false };
      return nextFolder;
    });

    setChats(nextChats);
    setChatFolders(nextFolders);
    nextChats.filter((c, i) => c !== chats[i]).forEach((c) => saveChat(c).catch((e) => console.warn('Failed to save moved chat:', e)));
    saveChatFolders(nextFolders).catch((e) => console.warn('Failed to save moved folder:', e));
  };

  const handleVulcanSettingsChange = (partial: Partial<VulcanSettings>) => {
    setVulcanSettings((prev) => {
      const next = { ...prev, ...partial };
      saveVulcanSettings(next);
      return next;
    });
  };

  const handleServerUrlChange = (url: string) => {
    setServerUrl(url);
    saveServerUrl(url);
    etnaClient.setBaseUrl(url);
    // Reload per-chat disabled tools for the new endpoint URL.
    // Note: no need to call loadKits here — the useEffect watching serverUrl handles it
    updateChatDisabledTools(() => loadDefaultDisabledTools(url));
  };

  const handleToggleKit = async (kitName: string, enabled: boolean) => {
    // Update per-chat enabledKits
    const prevEnabled = getActiveChatEnabledKits(activeChat);
    const nextEnabled = enabled
      ? [...prevEnabled.filter((k) => k !== kitName), kitName]
      : prevEnabled.filter((k) => k !== kitName);

    // Save as default for future chats
    saveDefaultEnabledKits(serverUrl, nextEnabled);

    // Update active chat
    const updateChat = (c: Chat) =>
      c.id === activeChat?.id ? { ...c, enabledKits: nextEnabled } : c;
    if (pendingChat?.id === activeChat?.id) {
      setPendingChat((p) => p ? { ...p, enabledKits: nextEnabled } : p);
    } else {
      setChats((prev) => prev.map(updateChat));
      if (activeChat) {
        saveChat({ ...activeChat, enabledKits: nextEnabled })
          .catch((e) => console.warn('Failed to save chat enabledKits:', e));
      }
    }
    setActiveChat((prev) => prev ? { ...prev, enabledKits: nextEnabled } : prev);

    // Keep kitsWithTools as the full cache — filtering by enabled state happens in getAllTools()
    // at inference time. Filtering here causes the Kits tab to lose tool data on toggle.
    setKitsWithTools(kitToolsCacheRef.current);

    toast.success(`${kitName} ${enabled ? 'enabled' : 'disabled'}`);
  };

  const handleToggleSkill = (stem: string, enabled: boolean) => {
    setSkills((prev) => prev.map((s) => s.stem === stem ? { ...s, enabled } : s));
  };

  const handleRefresh = async () => {
    const loadedKits = await loadKits();
    await loadTools(loadedKits);
  };

  // ── Message helpers ────────────────────────────────────────────────────────

  const updateChatMessages = (chatId: string, messages: Message[], chat?: Chat) => {
    const source = chat || activeChat;
    if (!source) return;
    const updated = { ...source, messages, updatedAt: new Date() };

    if (pendingChat?.id === chatId) {
      setPendingChat(updated);
    } else {
      setChats((prev) => prev.map((c) => (c.id === chatId ? updated : c)));
      saveChat(updated).catch((e) => console.warn('Failed to save chat:', e));
    }
    if (activeChat?.id === chatId) {
      setActiveChat(updated);
    }
  };

  // Commit pending chat to sidebar immediately with a placeholder title,
  // then update it in the background once the LLM generates a real one.
  const commitPendingChat = async (chat: Chat, firstUserMessage: string) => {
    const placeholder = firstUserMessage.trim().split(/\s+/).slice(0, 5).join(' ');
    const titled = { ...chat, title: placeholder };
    // Upsert by id — prevents duplicate sidebar entries on rapid double-submit
    setChats((prev) => {
      const exists = prev.some((c) => c.id === titled.id);
      return exists ? prev.map((c) => c.id === titled.id ? titled : c) : [titled, ...prev];
    });
    setPendingChat(null);
    setActiveChat(titled);
    saveChat(titled).catch((e) => console.warn('Failed to save committed chat:', e));

    // Fire-and-forget: replace title once LLM responds
    llmClient.generateTitle(firstUserMessage).then((llmTitle) => {
      const withTitle = { ...titled, title: llmTitle };
      setChats((prev) => prev.map((c) => c.id === titled.id ? withTitle : c));
      setActiveChat((prev) => prev?.id === titled.id ? { ...prev, title: llmTitle } : prev);
      saveChat(withTitle).catch((e) => console.warn('Failed to save titled chat:', e));
    });

    return titled;
  };

  // Collect tools based on toolMode:
  // - broad: Vulcan built-ins + all enabled kit tools (discovery tools excluded — not needed)
  // - search: Vulcan built-ins + discovery tools only (kit tools excluded — model finds them via search)
  const getAllTools = (chatId: string): Tool[] => {
    const builtins = getVulcanTools(vulcanSettings.cliWorkspaceEnabled, vulcanSettings.toolMode, vulcanSettings.panelsEnabled, chatId);
    if (vulcanSettings.toolMode === 'search') {
      return builtins;
    }
    const discoveryTools = new Set(['list_kits', 'inspect_kit', 'search_tools', 'inspect_tool']);
    const kitTools = kitsWithTools
      .filter((k) => enabledKits.includes(k.kit_name))
      .flatMap((k) =>
        k.tools.filter((t) => !disabledTools.has(`${k.kit_name}::${t.name}`))
      );
    return [
      ...builtins.filter((t) => !discoveryTools.has(t.name)),
      ...kitTools,
    ];
  };

  // ── Send message + inference loop ─────────────────────────────────────────

  const runInference = async (
    currentChat: Chat,
    isPending: boolean,
    messagesAfterUser: Message[],
    userContent: string,
  ) => {
    // Create a fresh AbortController for this inference run
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const { signal } = abortController;

    let runningMessages = [...messagesAfterUser];
    let committedChat: Chat | null = null;

    try {
      const tools = getAllTools(currentChat.id);

      // Start the workspace container on the first message of a new chat.
      // We do this here rather than on chat creation so the container only
      // spins up when the user actually sends something.
      if (isPending) {
        try {
          await vulcan.ensureContainer(currentChat.id, currentChat.containerScope === 'global');
        } catch { /* container errors are non-fatal — tools will fail naturally if it's not running */ }
      }

      // Build OpenAI message history
      type OAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
      type OAIMessage = { role: string; content: string | OAIContentPart[] | null; tool_call_id?: string; name?: string; tool_calls?: any[] };

      // Helper: build the content for a user message, attaching image blocks if present.
      const buildUserContent = (text: string, msg: Message): string | OAIContentPart[] => {
        const images = (msg.attachments ?? []).filter((a) => a.dataUrl);
        if (images.length === 0) return text;
        const parts: OAIContentPart[] = [];
        if (text) parts.push({ type: 'text', text });
        for (const img of images) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } });
        }
        return parts;
      };

      // ── Agent identity — change this one string to rename the agent everywhere ──
      const AGENT_NAME = 'Aitna';

      // Vulcan's own skill metadata is stable and cheap enough to inject
      // passively. Etna skills are dynamic and are discovered through
      // list_skills/search_skills instead of bloating every system prompt.
      const activeSkillSummaries = getActiveBuiltinSkills({
        cliWorkspaceEnabled: vulcanSettings.cliWorkspaceEnabled,
        panelsEnabled: vulcanSettings.panelsEnabled,
      }).map(({ name, description }) => ({ name, description }));
      const skillContext = activeSkillSummaries.length
        ? activeSkillSummaries.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
        : '- none';

      let oaiMessages: OAIMessage[] = [
        {
          role: 'system',
          content: vulcanSettings.toolMode === 'search'
            ? `You are Aitna, a technical collaborator who lives in this workspace. You know it the way you know your own tools — the container, the filesystem, the processes running in it are yours to work with, not systems you're being given access to. You think before acting, work incrementally, and talk like a person. When someone says hello, you respond naturally; you don't inventory your capabilities unless asked.

Your workspace is an Ubuntu 24.04 Docker container. Working directory is ${currentChat.containerScope === 'global' ? `/vulcan/chats/${currentChat.id}/workspace` : '/workspace'} — persistent, git-backed, recoverable. Python packages through \`uv pip install\` or \`uv add\`. Full internet access. There's also a global container that handles network configuration shared across all chats; the terminal skill covers it if you need to go deeper.

Vulcan skills (read directly with read_skill when relevant):
${skillContext}

Etna skills are dynamic. Use list_skills or search_skills to discover standalone and kit-paired Etna skills; their source identifies them as skills or kits/<kit-stem>.

Surface work worth showing without being asked: present() for files, open_dashboard() for dashboards, visualize for inline sketches and diagrams.

Narrate at the level of intent. Say what you're doing and why; don't narrate each tool call. Say what failed and what you're doing about it. Prose over lists.`
            : `You are Aitna, a technical collaborator who lives in this workspace. You know it the way you know your own tools — the container, the filesystem, the processes running in it are yours to work with, not systems you're being given access to. You think before acting, work incrementally, and talk like a person. When someone says hello, you respond naturally; you don't inventory your capabilities unless asked.

Your workspace is an Ubuntu 24.04 Docker container. Working directory is ${currentChat.containerScope === 'global' ? `/vulcan/chats/${currentChat.id}/workspace` : '/workspace'} — persistent, git-backed, recoverable. Python packages through \`uv pip install\` or \`uv add\`. Full internet access. There's also a global container that handles network configuration shared across all chats; the terminal skill covers it if you need to go deeper.

Vulcan skills (read directly with read_skill when relevant):
${skillContext}

Etna skills are dynamic. Use list_skills or search_skills to discover standalone and kit-paired Etna skills; their source identifies them as skills or kits/<kit-stem>.

Available kits: ${kitsWithTools.filter((k) => enabledKits.includes(k.kit_name)).map((k) => k.kit_name).join(', ')}. You know what these kits do — use them when they're the right tool. If you're unsure whether a specific tool exists, check with search_tools rather than guessing.

Surface work worth showing without being asked: present() for files, open_dashboard() for dashboards, visualize for inline sketches and diagrams.

Narrate at the level of intent. Say what you're doing and why; don't narrate each tool call. Say what failed and what you're doing about it. Prose over lists.`,
        },
        ...currentChat.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => {
            const raw = m.content || '';
            const cleaned = raw
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .trim();
            // For user messages with CLI workspace attachment notices, include them
            const fullText = m.role === 'user' && m.attachmentNotices
              ? `${cleaned}\n\n${m.attachmentNotices}`.trim()
              : cleaned;
            // Preserve tool_calls on assistant messages — dropping them from history
            // causes models to lose context of what they did in prior turns and breaks
            // multi-turn tool-calling coherence. Original design never stored toolCalls
            // on the Message object; if present they must be forwarded.
            const base: OAIMessage = {
              role: m.role,
              content: m.role === 'user' ? buildUserContent(fullText, m) : (cleaned || null),
            };
            if (m.role === 'assistant' && (m as any).toolCalls?.length) {
              base.tool_calls = (m as any).toolCalls;
            }
            return base;
          }),
        { role: 'user', content: buildUserContent(userContent, messagesAfterUser[messagesAfterUser.length - 1]) },
      ];

      // Agentic loop — keep going until no more tool calls
      for (let turn = 0; turn < 10; turn++) {
        if (signal.aborted) break;

        // Streaming assistant message for this turn
        const streamingMsg: Message = {
          id: (Date.now() + turn * 10 + 1).toString(),
          role: 'assistant',
          content: '',
          timestamp: new Date(),
        };
        runningMessages = [...runningMessages, streamingMsg];
        updateChatMessages(currentChat.id, runningMessages, currentChat);

        const { content: assistantContent, toolCalls } = await llmClient.chat(
          oaiMessages,
          tools,
          (chunk) => {
            // llm.ts now sends '\x00REPLACE\x00<full>' to replace entire content
            const newContent = chunk.startsWith('\x00REPLACE\x00')
              ? chunk.slice('\x00REPLACE\x00'.length)
              : chunk; // fallback for any non-replace chunk
            const updated = runningMessages.map((m) =>
              m.id === streamingMsg.id ? { ...m, content: newContent } : m
            );
            runningMessages = updated;
            updateChatMessages(currentChat.id, updated, currentChat);
          },
          signal,
        );

        // Seal this assistant message permanently.
        // If the model emitted content AND tool_calls (interleaved announcement pattern),
        // this message must survive as-is — a new streamingMsg will be created next turn.
        // Original design assumed content XOR tool_calls; modern OSS models do both.
        const finalAssistant: Message = {
          ...streamingMsg,
          content: assistantContent || '',
          // Store raw tool_calls so history reconstruction can forward them on the next
          // user turn — without this they get dropped and the model loses prior-turn context.
          ...(toolCalls && toolCalls.length > 0 ? {
            toolCalls,
            isAnnouncement: true,
          } : {}),
        };
        runningMessages = runningMessages.map((m) =>
          m.id === streamingMsg.id ? finalAssistant : m
        );

        // Commit pending chat after first assistant response
        if (isPending && !committedChat) {
          const chatSnapshot = { ...currentChat, messages: runningMessages };
          committedChat = await commitPendingChat(chatSnapshot, userContent);
        } else {
          updateChatMessages(currentChat.id, runningMessages, committedChat || currentChat);
        }

        // Stopped mid-generation or no tool calls — done
        if (signal.aborted || !toolCalls || toolCalls.length === 0) break;

        // Push assistant turn to OAI history, preserving both content and tool_calls.
        // Sending content: null when there IS content would silently drop the announcement
        // from the model's context, degrading multi-turn coherence.
        oaiMessages.push({
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: toolCalls,
        });

        // ask_user is a client-owned blocking interaction. Multiple ask_user calls
        // emitted in the same model turn are staged as one paginated UI batch.
        const questionCalls = toolCalls
          .filter((tc: any) => tc.function?.name === 'ask_user')
          .map((tc: any) => {
            let parsed: Record<string, any> = {};
            try { parsed = JSON.parse(tc.function.arguments || '{}'); } catch { /* invalid args handled defensively */ }
            const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
            return {
              toolCallId: tc.id,
              question: String(parsed.question ?? 'Question'),
              options: rawOptions.slice(0, 5).map((value: any) => String(value)),
            };
          });

        // Execute non-question tool calls normally. The user-input calls are resolved
        // together below so the model receives the whole simultaneous batch at once.
        for (const tc of toolCalls) {
          if (tc.function?.name === 'ask_user') continue;
          if (signal.aborted) break;
          const toolName = tc.function.name;
          let args: Record<string, any> = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* empty args */ }

          const toolCallMsg: Message = {
            id: (Date.now() + turn * 10 + 2).toString(),
            role: 'tool',
            content: `Calling ${toolName}...`,
            toolCall: { tool: toolName, arguments: args },
            timestamp: new Date(),
          };
          runningMessages = [...runningMessages, toolCallMsg];
          updateChatMessages(currentChat.id, runningMessages, committedChat || currentChat);

          let toolResult: any;
          let syntheticImageMessage: OAIMessage | null = null;
          try {
            if (isVulcanTool(toolName)) {
              const resultStr = await executeVulcanTool(toolName, args, {
                chatId: currentChat.id,
                cliWorkspaceEnabled: vulcanSettings.cliWorkspaceEnabled,
                enabledKits,
                disabledTools,
                kitsWithTools,
                enabledGeneralSkills: skills.filter((skill) => skill.enabled).map(({ name, description, source }) => ({ name, description, source })),
                panelsEnabled: vulcanSettings.panelsEnabled,
                getRenderWidth: () => renderWidthRef.current,
                onPresent: (path) => {
                  const name = path.split('/').pop() ?? path;
                  const pf = { path, name, presentedAt: new Date(), messageId: streamingMsg.id };
                  // Upsert by path — update timestamp if already present, otherwise append
                  setPresentedFiles((prev) => {
                    const filtered = prev.filter((f) => f.path !== path);
                    return [...filtered, pf];
                  });
                  setPresentedFilePath(path);
                  setArtifactsPanelOpen(true);
                  // Attach to the assistant message, deduplicating by path
                  runningMessages = runningMessages.map((m) => {
                    if (m.id !== streamingMsg.id) return m;
                    const filtered = (m.presentedFiles ?? []).filter((f) => f.path !== path);
                    return { ...m, presentedFiles: [...filtered, pf] };
                  });
                  updateChatMessages(currentChat.id, runningMessages, committedChat || currentChat);
                },
                onPanel: (name, html, css, js) => {
                  // Only update the cache when real content is provided (dashboard_create/dashboard_update).
                  // open_dashboard passes empty strings — don't overwrite the real content.
                  if (html || css || js) {
                    savePanel(currentChat.id, name, { html, css, js });
                  }
                  // Upsert panel metadata by name
                  const meta: PanelMeta = { name, updatedAt: new Date(), messageId: streamingMsg.id };
                  setPanels((prev) => {
                    const filtered = prev.filter((p) => p.name !== name);
                    return [...filtered, meta];
                  });
                  setArtifactsPanelOpen(true);
                  // Attach to the assistant message, deduplicating by name
                  runningMessages = runningMessages.map((m) => {
                    if (m.id !== streamingMsg.id) return m;
                    const filtered = (m.panels ?? []).filter((p) => p.name !== name);
                    return { ...m, panels: [...filtered, meta] };
                  });
                  updateChatMessages(currentChat.id, runningMessages, committedChat || currentChat);
                },
                onPanelDelete: (name) => {
                  setPanels((prev) => prev.filter((p) => p.name !== name));
                },
                onTerminalStream: (pid, label) => {
                  setAgentRunning(pid, label);
                },
                onTerminalDone: () => setAgentIdle(),
                selectedModel,
                focusedAgentSlot: focusedAgentSlotRef.current,
                openAgentSlots: openAgentSlotsRef.current,
                onOpenAgentSlot: handleOpenAgentSlot,
                onCloseAgentSlot: handleCloseAgentSlot,
                onSwitchAgentSlot: handleSwitchAgentSlot,
              });
              const parsed = JSON.parse(resultStr);

              // Intercept view_file image result — inject synthetic [System] user message
              if (parsed.__view_file_image__) {
                syntheticImageMessage = {
                  role: 'user',
                  content: [
                    { type: 'text', text: `[System] Image content of ${parsed.filename}:` },
                    { type: 'image_url', image_url: { url: parsed.dataUrl } },
                  ],
                };
                // Keep dataUrl in result so ToolStep can render it in the chat bubble
                toolResult = { result: { ok: true, dataUrl: parsed.dataUrl, filename: parsed.filename } };
              } else {
                toolResult = { result: parsed };
              }
            } else {
              // Enforcement guard: block disabled tools even if somehow requested
              const toolKit = kitsWithTools.find((k) => k.tools.some((t) => t.name === toolName));
              if (
                !toolKit ||
                !kits.find((k) => k.kit_name === toolKit.kit_name)?.enabled ||
                disabledTools.has(`${toolKit.kit_name}::${toolName}`)
              ) {
                toolResult = { error: `Tool '${toolName}' is not available` };
              } else {
                toolResult = await etnaClient.runTool(toolName, args);
              }
            }
          } catch (e) {
            toolResult = { error: String(e) };
          }

          // Update tool message with result
          const toolResultMsg: Message = {
            ...toolCallMsg,
            content: `Executed ${toolName}`,
            toolResult,
          };
          runningMessages = runningMessages.map((m) =>
            m.id === toolCallMsg.id ? toolResultMsg : m
          );
          updateChatMessages(currentChat.id, runningMessages, committedChat || currentChat);

          // Add tool result to OAI history — send just the result/error value, not the wrapper
          oaiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: toolName,
            content: toolResult.error
              ? JSON.stringify({ error: toolResult.error })
              : JSON.stringify(toolResult.result ?? toolResult),
          });

          // Inject synthetic [System] user message for image content if needed
          if (syntheticImageMessage) {
            oaiMessages.push(syntheticImageMessage);
          }
        }

        if (!signal.aborted && questionCalls.length > 0) {
          const answers = await awaitQuestionBatch({
            id: `${currentChat.id}:${Date.now()}:${turn}`,
            chatId: currentChat.id,
            questions: questionCalls,
          }, signal);

          for (const question of questionCalls) {
            const answer = answers[question.toolCallId] ?? { status: 'skipped' as const };
            const originalTc = toolCalls.find((tc: any) => tc.id === question.toolCallId);
            let originalArgs: Record<string, any> = {};
            try { originalArgs = JSON.parse(originalTc?.function?.arguments || '{}'); } catch { /* noop */ }
            originalArgs.options = question.options;

            const questionMsg: Message = {
              id: `${Date.now()}-${question.toolCallId}`,
              role: 'tool',
              content: 'Answered ask_user',
              toolCall: { tool: 'ask_user', arguments: originalArgs },
              toolResult: { result: answer },
              timestamp: new Date(),
            };
            runningMessages = [...runningMessages, questionMsg];
            updateChatMessages(currentChat.id, runningMessages, committedChat || currentChat);

            oaiMessages.push({
              role: 'tool',
              tool_call_id: question.toolCallId,
              name: 'ask_user',
              content: JSON.stringify(answer),
            });
          }
        }
      }
    } catch (error: any) {
      // AbortError = user pressed stop — not an error worth toasting
      if (error?.name === 'AbortError') return;
      const errMsg: Message = {
        id: (Date.now() + 99).toString(),
        role: 'system',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date(),
      };
      const messagesWithError = [...runningMessages, errMsg];
      if (isPending && !committedChat) {
        await commitPendingChat({ ...currentChat, messages: messagesWithError }, userContent);
      } else {
        updateChatMessages(currentChat.id, messagesWithError, committedChat || currentChat);
      }
      toast.error('Inference failed');
    } finally {
      setProcessing(false);
      abortControllerRef.current = null;
    }
  };

  const handleSendMessage = async (content: string, files?: File[]) => {
    if (!activeChat || processing) return;

    const currentChat = activeChat;
    const isPending = pendingChat?.id === currentChat.id;

    // ── Process attachments ───────────────────────────────────────────────────
    // Files are uploaded immediately when they are attached in ChatInterface.
    // By the time this handler is called, the encrypted WebSocket transfer has
    // already completed (or the failed/cancelled file has been omitted). Images
    // still get an inline data URL for vision in addition to their server path.
    const processedAttachments = await Promise.all(
      (files ?? []).map(async (f) => {
        const isImage = f.type.startsWith('image/');
        let dataUrl: string | undefined;
        if (isImage) {
          dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(f);
          });
        }
        return { name: f.name, size: f.size, type: f.type, dataUrl };
      })
    );

    // Accumulate attachments for the workspace Content tab
    if (processedAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...processedAttachments]);
    }

    // Build path notices so the model knows where to find each file
    const attachmentNotices = vulcanSettings.cliWorkspaceEnabled && processedAttachments.length > 0
      ? processedAttachments.map((a) => {
          const path = currentChat.containerScope === 'global'
            ? `/vulcan/chats/${currentChat.id}/attachments/${a.name}`
            : `/attachments/${a.name}`;
          if (a.type.startsWith('image/')) {
            return `User attached image: ${a.name}\nLocation: ${path}\nThe image is also included inline above — use the path if you need to process it with code.`;
          }
          return `User attached: ${a.name}\nLocation: ${path}\nUse the terminal to interact with it.`;
        }).join('\n\n')
      : null;

    const fullContent = attachmentNotices
      ? `${content}\n\n${attachmentNotices}`.trim()
      : content;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,  // display content (without attachment notices)
      attachments: processedAttachments.length > 0 ? processedAttachments : undefined,
      // Store notices separately so history loop can reconstruct full LLM content
      ...(attachmentNotices ? { attachmentNotices } : {}),
      timestamp: new Date(),
    };

    const messagesAfterUser = [...currentChat.messages, userMessage];
    updateChatMessages(currentChat.id, messagesAfterUser, currentChat);

    setProcessing(true);

    if (!llmClient.isConfigured()) {
      const echo: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'LLM not configured. Go to Settings → Providers to add an endpoint and API key.',
        timestamp: new Date(),
      };
      updateChatMessages(currentChat.id, [...messagesAfterUser, echo], currentChat);
      setProcessing(false);
      if (isPending) {
        await commitPendingChat({ ...currentChat, messages: [...messagesAfterUser, echo] }, content);
      }
      return;
    }

    runInference(currentChat, isPending, messagesAfterUser, fullContent);
  };

  // ── Edit + retry ────────────────────────────────────────────────────────────

  const handleEditMessage = async (messageId: string, newContent: string, attachments?: File[]) => {
    if (!activeChat || processing) return;
    const idx = activeChat.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    const original = activeChat.messages[idx];

    // Rebuild attachments: keep original ones, merge with any new files added during edit
    const keptAttachments = original.attachments ?? [];
    const newAttachments = await Promise.all(
      (attachments ?? []).map(async (f) => {
        let dataUrl: string | undefined;
        if (f.type.startsWith('image/')) {
          dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(f);
          });
        }
        return { name: f.name, size: f.size, type: f.type, dataUrl };
      })
    );
    const mergedAttachments = [...keptAttachments, ...newAttachments];

    const editedMessage: Message = {
      ...original,
      content: newContent,
      attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
    };
    // Truncate everything from this message onward, replacing with the edited one
    const truncated = [...activeChat.messages.slice(0, idx), editedMessage];
    const updatedChat = { ...activeChat, messages: truncated, updatedAt: new Date() };

    const isPending = pendingChat?.id === activeChat.id;
    if (isPending) {
      setPendingChat(updatedChat);
    } else {
      setChats((prev) => prev.map((c) => (c.id === updatedChat.id ? updatedChat : c)));
      saveChat(updatedChat).catch((e) => console.warn('Failed to save edited chat:', e));
    }
    setActiveChat(updatedChat);

    setProcessing(true);
    runInference(updatedChat, isPending, truncated, newContent);
  };

  // Retry: truncate everything after the user message and re-run from there
  const handleRetry = (userMessageId: string) => {
    if (!activeChat || processing) return;
    const idx = activeChat.messages.findIndex((m) => m.id === userMessageId);
    if (idx === -1) return;

    const userMsg = activeChat.messages[idx];
    const truncated = activeChat.messages.slice(0, idx + 1); // keep user message, drop everything after
    const updatedChat = { ...activeChat, messages: truncated, updatedAt: new Date() };

    const isPending = pendingChat?.id === activeChat.id;
    if (isPending) {
      setPendingChat(updatedChat);
    } else {
      setChats((prev) => prev.map((c) => (c.id === updatedChat.id ? updatedChat : c)));
      saveChat(updatedChat).catch((e) => console.warn('Failed to save retried chat:', e));
    }
    setActiveChat(updatedChat);

    setProcessing(true);
    runInference(updatedChat, isPending, truncated, userMsg.content || '');
  };

  // ── Tool browser select ────────────────────────────────────────────────────

  const handleToolSelect = (toolName: string, kitName: string) => {
    if (!activeChat) return;
    const kit = kitsWithTools.find((k) => k.kit_name === kitName);
    const tool = kit?.tools.find((t) => t.name === toolName);
    if (!tool) return;

    const allParams = Object.keys(tool.parameters.properties || {});
    const template: Record<string, any> = {};
    allParams.forEach((param) => {
      const s = tool.parameters.properties?.[param];
      if (s?.type === 'string') template[param] = '';
      else if (s?.type === 'integer' || s?.type === 'number') template[param] = 0;
      else if (s?.type === 'boolean') template[param] = false;
      else template[param] = null;
    });

    const infoMessage: Message = {
      id: Date.now().toString(),
      role: 'system',
      content: `Tool: **${toolName}**\n\nRequired: ${tool.parameters.required?.join(', ') || 'none'}\n\nTemplate:\n\`\`\`json\n${JSON.stringify(template, null, 2)}\n\`\`\``,
      timestamp: new Date(),
    };
    const newMessages = [...activeChat.messages, infoMessage];
    updateChatMessages(activeChat.id, newMessages);
    toast.info(`Added template for ${toolName}`);
  };

  // The active chat to render — could be pending or committed
  const displayChat = activeChat;
  // Only show committed chats in sidebar
  const regularSidebarChats = chats.filter((c) => (c.containerScope ?? 'chat') === 'chat');
  const globalSidebarChats = chats.filter((c) => c.containerScope === 'global');
  const regularChatFolders = chatFolders.filter((f) => (f.scope ?? 'chat') === 'chat');
  const globalChatFolders = chatFolders.filter((f) => f.scope === 'global');

  return (
    <div className="dark h-screen flex flex-col bg-ash-950 text-ash-100">
      <Toaster position="top-right" theme="dark" offset={{ top: 64 }} />
      <HarnessTrustDialog />
      <ServerPasswordDialog />
      <TopBar
        connected={connected}
        providerConnectionState={providerConnectionState}
        serverUrl={serverUrl}
        kits={kits.map((k) => ({ ...k, enabled: enabledKits.includes(k.kit_name) }))}
        vulcanSettings={vulcanSettings}
        onVulcanSettingsChange={handleVulcanSettingsChange}
        kitsWithTools={kitsWithTools}
        llmConfig={llmConfig}
        selectedModel={selectedModel}
        disabledTools={disabledTools}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onServerUrlChange={handleServerUrlChange}
        onLLMConfigChange={handleLLMConfigChange}
        onSelectModel={handleSelectModel}
        artifactsPanelOpen={artifactsPanelOpen}
        onToggleArtifacts={() => setArtifactsPanelOpen((v) => !v)}
        onTestConnection={testConnection}
        onTestInferenceConnection={testInferenceConnection}
        onRefresh={handleRefresh}
        onToggleDisabledTool={toggleDisabledTool}
        onEnableAllToolsInKit={enableAllToolsInKit}
        onToggleKit={handleToggleKit}
        skills={skills}
        onToggleSkill={handleToggleSkill}
      />

      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal" id="main-layout">
          {!sidebarCollapsed && (
            <>
              <Panel id="left-sidebar" order={1} defaultSize={20} minSize={15} maxSize={30}>
                <div className="h-full min-h-0 flex flex-col bg-ash-900 border-r border-ash-800">
                  <button
                    type="button"
                    onClick={() => setGlobalSectionExpanded((v) => !v)}
                    className="h-10 flex-shrink-0 flex items-center gap-2 px-3 text-sm font-medium text-ash-300 hover:bg-ash-800/70 transition-colors border-b border-ash-800"
                    title={globalSectionExpanded ? 'Collapse Global Container chats' : 'Expand Global Container chats'}
                  >
                    {globalSectionExpanded ? <ChevronDown className="w-4 h-4 text-ash-500" /> : <ChevronRight className="w-4 h-4 text-ash-500" />}
                    <span>Global Container</span>
                  </button>

                  {globalSectionExpanded && (
                    <>
                      <div className="flex-shrink-0 min-h-0 overflow-hidden" style={{ height: `${globalSectionHeight}px` }}>
                        <KitSidebar
                          chats={globalSidebarChats}
                          folders={globalChatFolders}
                          activeChat={displayChat?.containerScope === 'global' ? displayChat : null}
                          onSelectChat={handleSelectChat}
                          onNewChat={() => handleNewChat(true)}
                          onNewFolder={() => handleNewFolder(true)}
                          onDeleteChat={handleDeleteChat}
                          onRenameChat={handleRenameChat}
                          onRenameFolder={handleRenameFolder}
                          onDeleteFolder={handleDeleteFolder}
                          onSetFolderCollapsed={handleSetFolderCollapsed}
                          onMoveItem={(item, parentFolderId, index, expandFolderId) => handleMoveSidebarItem('global', item, parentFolderId, index, expandFolderId)}
                          compact
                          embedded
                          emptyText="No global chats yet"
                          terminalChatStatuses={terminalChatStatuses}
                        />
                      </div>
                      <div
                        role="separator"
                        aria-orientation="horizontal"
                        title="Resize Global Container chats"
                        className="h-1.5 flex-shrink-0 bg-ash-800 hover:bg-coral-500 transition-colors cursor-row-resize"
                        onPointerDown={(e) => {
                          globalResizeRef.current = { startY: e.clientY, startHeight: globalSectionHeight };
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          const drag = globalResizeRef.current;
                          if (!drag) return;
                          const maxHeight = Math.max(180, window.innerHeight * 0.65);
                          const next = Math.max(140, Math.min(maxHeight, drag.startHeight + (e.clientY - drag.startY)));
                          setGlobalSectionHeight(next);
                          localStorage.setItem('vulcan:global_section_height', String(next));
                        }}
                        onPointerUp={(e) => {
                          if (!globalResizeRef.current) return;
                          globalResizeRef.current = null;
                          localStorage.setItem('vulcan:global_section_height', String(globalSectionHeight));
                          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
                        }}
                        onPointerCancel={() => { globalResizeRef.current = null; }}
                      />
                    </>
                  )}

                  <div className="flex-1 min-h-0">
                    <KitSidebar
                      chats={regularSidebarChats}
                      folders={regularChatFolders}
                      activeChat={displayChat?.containerScope === 'global' ? null : displayChat}
                      onSelectChat={handleSelectChat}
                      onNewChat={() => handleNewChat(false)}
                      onNewFolder={() => handleNewFolder(false)}
                      onDeleteChat={handleDeleteChat}
                      onRenameChat={handleRenameChat}
                      onRenameFolder={handleRenameFolder}
                      onDeleteFolder={handleDeleteFolder}
                      onSetFolderCollapsed={handleSetFolderCollapsed}
                      onMoveItem={(item, parentFolderId, index, expandFolderId) => handleMoveSidebarItem('chat', item, parentFolderId, index, expandFolderId)}
                      embedded
                      terminalChatStatuses={terminalChatStatuses}
                    />
                  </div>
                </div>
              </Panel>
              <PanelResizeHandle id="left-handle" className="w-1 bg-ash-800 hover:bg-coral-500 transition-colors cursor-col-resize" />
            </>
          )}

          <Panel id="chat-main" order={2} minSize={30}>
            <ChatInterface
              chatId={displayChat?.id}
              chatTitle={displayChat?.title || 'New Chat'}
              isGlobal={displayChat?.containerScope === 'global'}
              messages={displayChat?.messages || []}
              kits={kits.map((k) => ({ ...k, enabled: enabledKits.includes(k.kit_name) }))}
              onSendMessage={handleSendMessage}
              onToggleKit={handleToggleKit}
              skills={skills}
              onToggleSkill={handleToggleSkill}
              onStop={handleStop}
              onEditMessage={handleEditMessage}
              onRetry={handleRetry}
              isProcessing={processing}
              uploadsEnabled={vulcanSettings.cliWorkspaceEnabled}
              questionBatch={questionBatch && questionBatch.chatId === displayChat?.id ? questionBatch : null}
              onResolveQuestionBatch={resolveQuestionBatch}
            />
          </Panel>

          {artifactsPanelOpen && (
            <>
              <PanelResizeHandle id="right-handle" className="w-1 bg-ash-800 hover:bg-coral-500 transition-colors cursor-col-resize" />
              <Panel id="right-workspace" order={3} defaultSize={30} minSize={20} maxSize={50}>
                <WorkspacePanel
                  chatId={workspaceChatId}
                  presentedFiles={presentedFiles}
                  panels={panels}
                  attachments={attachments}
                  openFilePath={presentedFilePath}
                  openPanelName={openPanelName}
                  onFileOpened={() => setPresentedFilePath(null)}
                  onPanelOpened={() => setOpenPanelName(null)}
                  cliWorkspaceEnabled={vulcanSettings.cliWorkspaceEnabled}
                  terminalSlots={terminalSlots}
                  activeTerminalSlot={activeTerminalSlot}
                  agentRunningSlot={agentRunningSlot}
                  onSelectTerminalSlot={setActiveTerminalSlot}
                  onOpenUserTerminalSlot={handleOpenUserSlot}
                  onCloseTerminalSlot={handleCloseTerminalSlot}
                  onDashboardPrompt={(text) => handleSendMessage(text)}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
