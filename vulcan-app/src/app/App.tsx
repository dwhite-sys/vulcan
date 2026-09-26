import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { TopBar } from './components/TopBar';
import { KitSidebar, type SidebarDragItem } from './components/KitSidebar';
import { ChatInterface } from './components/ChatInterface';
import { DesignSurface, type DesignSurfaceHandle } from './components/DesignSurface';
import { BranchGraph } from './components/BranchGraph';
import type { SkillMeta } from './components/SkillToggleMenu';
import { WorkspacePanel } from './components/WorkspacePanel';
import { HarnessTrustDialog } from './components/HarnessTrustDialog';
import { ServerPasswordDialog } from './components/ServerPasswordDialog';
import { UpdatePrompt } from './components/UpdatePrompt';
import { llmClient, testProviderConnection, type LLMConfig, type ProviderConfig, type LLMStreamEvent } from './services/llm';
import { getVulcanTools, getDesignSurfaceTools, isVulcanTool, executeVulcanTool } from './services/vulcanTools';
import { isVisionModel } from './services/modelVision';
import { BUILTIN_SKILLS, getActiveBuiltinSkills } from './skills/builtins';
import * as vulcan from './services/vulcan';
import {
  loadLLMConfig, saveLLMConfig,
  loadSelectedModel, saveSelectedModel,
  loadChats, loadChat, saveChat, deleteChat, loadChatFolders, saveChatFolders,
  loadDefaultEnabledKits, saveDefaultEnabledKits,
  loadDefaultDisabledTools, saveDefaultDisabledTools,
  loadVulcanSettings, saveVulcanSettings, loadDisabledEtnaSkills, saveDisabledEtnaSkills,
  loadProviders, cacheServerProviders, loadVulcanEndpoint, saveVulcanEndpoint,
  type VulcanSettings,
} from './services/persistence';
import { setGeneralWSBaseUrl } from './services/ws';
import { getVulcanWsBaseUrl } from './services/vulcanEndpoint';
import { assertCompatibleVulcanMeta, isLoopbackVulcanServerUrl, transitionVulcanServer, withServerSwitchProbeDeadline } from './services/serverSwitch';
import { isOfficialPlaywrightScreenshot, materializeOfficialPlaywrightScreenshot, prepareOfficialEtnaArguments } from './services/etnaOfficialKits';
import { loadEtnaServers, refreshEtnaState, probeEtnaHealth, clientDeviceId, runEtnaTool } from './services/etnaRegistry';
import { repairToolSemanticIndex, type ToolSemanticRuntimeIndex } from './services/toolSemanticCache';
import type { VulcanServerProfile } from './services/serverProfiles';
import { savePanel, deleteChatPanels } from './services/panelCache';
import { applyLLMStreamEvent, createTurnStreamState, sealTurnSemantic, rehydrateChatEvents } from './services/transcript';
import { projectWorkspaceAssets, reconcileDashboardInventory, workspaceAssetRevision } from './services/workspaceAssets';
import type { Kit, KitWithTools, LogicalEtnaKit, EtnaServerProfile, EtnaSummary, Chat, ChatEvent, ChatFolder, Tool, PresentedFile, DesignAttachment, MessageAttachment, MessageEditPayload, MessageElementReference, MessageFileReference, MessageQuote, Panel as PanelMeta, TerminalSlotMeta, SlotKind, UserQuestionBatch, UserQuestionAnswer, UserMessageEvent, AssistantTextEvent, ToolEvent, SystemMessageEvent } from './types/vulcan';
import { projectQuotedContent } from './services/quoteProjection';
import { mergeEditedAttachments } from './services/messageEditing';
import { advanceSearchChatId, advanceSearchIndex, clampSearchIndex, firstSearchMatchPerEvent, searchTranscript, unhydratedTranscriptSearchMatches, type TranscriptSearchMatch } from './services/transcriptSearch';
import { filterSidebarByQuery } from './services/sidebarOrdering';
import { branchById, branchEvents, createBranch, ensureBranching, renameBranch, syncCurrentBranch } from './services/branching';
import { toast, Toaster } from 'sonner';
import { noteLocalToolRepeat, type ToolRepeatState } from './services/toolRepeatGuard';

const getEtnaClientDeviceId = clientDeviceId;

function normalizeDesignUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [activeVulcanEndpoint, setActiveVulcanEndpoint] = useState(() => loadVulcanEndpoint());
  const [isSwitchingVulcanServer, setIsSwitchingVulcanServer] = useState(false);
  const vulcanServerSwitchingRef = useRef(false);
  const serverContextGenerationRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [vulcanConnected, setVulcanConnected] = useState(() => vulcan.generalWS.connected && vulcan.generalWS.authenticated);
  const [providerConnectionState, setProviderConnectionState] = useState<'none' | 'partial' | 'all'>('none');
  const [artifactsPanelOpen, setArtifactsPanelOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const [openDesignId, setOpenDesignId] = useState<string | null>(null);
  const designChromeRestoreRef = useRef<{ sidebarCollapsed: boolean; artifactsPanelOpen: boolean } | null>(null);
  const designPanelRef = useRef<ImperativePanelHandle | null>(null);
  const designSurfaceRef = useRef<DesignSurfaceHandle | null>(null);
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
  // updates are asynchronous, so open_terminal -> switch_terminal -> use_terminal
  // in a single assistant turn must not rely on a stale render snapshot.
  const focusedAgentSlotRef = useRef<number | null>(null);
  const openAgentSlotsRef = useRef<number[]>([]);
  const [agentRunningSlot, setAgentRunningSlot] = useState<{ kind: SlotKind; slot: number } | null>(null);
  const renderWidthRef = useRef<number>(680);
  const [kits, setKits] = useState<Kit[]>([]);
  const [kitsWithTools, setKitsWithTools] = useState<KitWithTools[]>([]);
  const [etnaServers, setEtnaServers] = useState<EtnaServerProfile[]>(() => loadEtnaServers());
  const [etnaLogicalKits, setEtnaLogicalKits] = useState<LogicalEtnaKit[]>([]);
  const [etnaSkillDescriptors, setEtnaSkillDescriptors] = useState<any[]>([]);
  const [etnaSummary, setEtnaSummary] = useState<EtnaSummary>({ servers: 0, kits: 0, tools: 0, healthy: 0, configured: 0, conflictServerIds: [] });
  const etnaHealthProbeInFlightRef = useRef(false);
  const providerHealthProbeRef = useRef<Promise<boolean> | null>(null);
  const toolSemanticIndexRef = useRef<ToolSemanticRuntimeIndex | null>(null);
  // kitToolsCache: populated once per connection, used to derive kitsWithTools without re-fetching
  const kitToolsCacheRef = useRef<KitWithTools[]>([]);
  const [kitsLoaded, setKitsLoaded] = useState(false);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const allSkills: SkillMeta[] = [
    ...BUILTIN_SKILLS.map(({ name, description }) => ({
      name,
      stem: `vulcan:${name}`,
      description,
      source: 'vulcan',
      enabled: !vulcanSettings.disabledVulcanSkills.includes(name),
    })),
    ...skills,
  ];

  // Chats — hydrated only after an authenticated server connection; pendingChat is in-memory only
  const [chats, setChats] = useState<Chat[]>([]);
  const chatsRef = useRef<Chat[]>([]);
  chatsRef.current = chats;
  const designsByChatRef = useRef<Record<string, DesignAttachment[]>>({});
  for (const chat of chats) designsByChatRef.current[chat.id] = chat.designs ?? [];
  const [chatFolders, setChatFolders] = useState<ChatFolder[]>([]);
  const [chatIndexHydrated, setChatIndexHydrated] = useState(false);
  const [pendingChat, setPendingChat] = useState<Chat | null>(null);
  const pendingChatIdRef = useRef<string | null>(null);
  if (pendingChat) designsByChatRef.current[pendingChat.id] = pendingChat.designs ?? [];
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  if (activeChat) designsByChatRef.current[activeChat.id] = activeChat.designs ?? [];
  const activeChatIdRef = useRef<string | null>(null);
  const chatSelectionGenerationRef = useRef(0);
  activeChatIdRef.current = activeChat?.id ?? null;
  const activeWorkspaceAssetRevision = activeChat ? workspaceAssetRevision(activeChat.events) : '';

  useEffect(() => {
    const panel = designPanelRef.current;
    if (!panel) return;
    if (designOpen) panel.expand();
    else panel.collapse();
  }, [designOpen, openDesignId]);

  // One universal search query drives sidebar discovery and the open transcript's
  // Ctrl+F-style highlights. Hit positions are intentionally per-chat so moving
  // through matching chats never loses each conversation's selected occurrence.
  const [universalSearchQuery, setUniversalSearchQuery] = useState('');
  const [searchHitIndexByChat, setSearchHitIndexByChat] = useState<Record<string, number>>({});
  const [branchMode, setBranchMode] = useState(false);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [branchSearchHitIndexById, setBranchSearchHitIndexById] = useState<Record<string, number>>({});
  const universalSearchInputRef = useRef<HTMLInputElement>(null);
  const [searchMatchesByChat, setSearchMatchesByChat] = useState<Map<string, TranscriptSearchMatch[]>>(new Map());
  const [branchSearchMatches, setBranchSearchMatches] = useState<Map<string, TranscriptSearchMatch[]>>(new Map());
  const searchGenerationRef = useRef(0);
  const branchSearchChatId = branchMode ? (activeChat?.id ?? null) : null;

  const searchContentMatchedChatIds = useMemo(() => new Set(
    [...searchMatchesByChat.entries()].filter(([, matches]) => matches.length > 0).map(([chatId]) => chatId),
  ), [searchMatchesByChat]);
  const searchVisibleChats = useMemo(() => filterSidebarByQuery(
    chats, chatFolders, universalSearchQuery, searchContentMatchedChatIds,
  ).chats, [chats, chatFolders, universalSearchQuery, searchContentMatchedChatIds]);
  const orderedSearchChatIds = useMemo(() => {
    if (!universalSearchQuery.trim()) return [];
    // Keep the keyboard traversal order stable even though the sidebar visually
    // pins the current result. Otherwise Ctrl+F3 could bounce between two chats
    // as each newly-selected chat moved to the front of the array.
    return [...searchVisibleChats]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((chat) => chat.id);
  }, [searchVisibleChats, universalSearchQuery]);

  const activeBranching = useMemo(() => activeChat ? ensureBranching(activeChat) : null, [activeChat]);
  const activeBranches = activeBranching?.branches ?? [];
  const effectiveSelectedBranchId = branchMode && activeBranching
    ? (selectedBranchId && branchById(activeBranching, selectedBranchId) ? selectedBranchId : activeBranching.currentBranchId)
    : null;
  const selectedBranch = activeBranching && effectiveSelectedBranchId ? branchById(activeBranching, effectiveSelectedBranchId) : undefined;
  const selectedBranchEvents = activeChat && effectiveSelectedBranchId ? branchEvents(activeChat, effectiveSelectedBranchId) : [];

  // Sidebar search results stay as lightweight FTS descriptors. Only the transcript
  // that is actually being displayed is hydrated into render-block indices. This
  // avoids rebuilding every matching conversation on the Electron renderer thread.
  const hydratedActiveChatSearchMatches = useMemo(() => {
    if (!activeChat || branchMode || !universalSearchQuery.trim()) return [];
    // Exact offsets are intentionally computed only for the one transcript the user
    // is actually viewing. Corpus-wide search remains lightweight FTS metadata.
    return firstSearchMatchPerEvent(searchTranscript(activeChat.events, universalSearchQuery));
  }, [activeChat, branchMode, universalSearchQuery]);

  const hydratedSelectedBranchSearchMatches = useMemo(() => {
    if (!activeChat || !branchMode || !effectiveSelectedBranchId || !universalSearchQuery.trim()) return [];
    return firstSearchMatchPerEvent(searchTranscript(selectedBranchEvents, universalSearchQuery));
  }, [activeChat, branchMode, effectiveSelectedBranchId, universalSearchQuery, selectedBranchEvents]);

  // Sidebar search is intentionally direct: FTS5 returns the matched message rows,
  // and the renderer paints those rows conversation-by-conversation. Full transcript
  // scanning is reserved for the one chat/branch actually being viewed.
  useEffect(() => {
    const query = universalSearchQuery.trim();
    const generation = ++searchGenerationRef.current;
    if (!query) {
      setSearchMatchesByChat(new Map());
      setBranchSearchMatches(new Map());
      return;
    }
    // Keep the last complete result set visible while the debounced request is in
    // flight. New results replace it atomically, avoiding the "messages vanished"
    // flicker that made search provenance appear unreliable.
    const timer = setTimeout(async () => {
      try {
        if (branchMode) {
          if (!activeChat) { setBranchSearchMatches(new Map()); return; }
          const result = await vulcan.searchBranches(activeChat.id, query);
          if (searchGenerationRef.current !== generation) return;
          const next = new Map<string, TranscriptSearchMatch[]>();
          if (!result.branch_ids.length) setBranchSearchMatches(new Map());
          for (const branchId of result.branch_ids) {
            if (searchGenerationRef.current !== generation) return;
            const matches = unhydratedTranscriptSearchMatches(result.hits_by_branch[branchId] ?? []);
            if (!matches.length) continue;
            next.set(branchId, matches);
            // Paint one complete branch's message list, then yield. Search results
            // appear progressively instead of building a large renderer update.
            setBranchSearchMatches(new Map(next));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          setSearchMatchesByChat(new Map());
        } else {
          const result = await vulcan.searchChats(query);
          if (searchGenerationRef.current !== generation) return;
          const next = new Map<string, TranscriptSearchMatch[]>();
          if (!result.chat_ids.length) setSearchMatchesByChat(new Map());
          for (const chatId of result.chat_ids) {
            if (searchGenerationRef.current !== generation) return;
            const matches = unhydratedTranscriptSearchMatches(result.hits_by_chat[chatId] ?? []);
            if (!matches.length) continue;
            next.set(chatId, matches);
            // FTS5 already returned the matching messages. Commit one conversation
            // at a time so the first result paints immediately and input/resize
            // keeps getting frames while the rest of the sidebar fills in.
            setSearchMatchesByChat(new Map(next));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          setBranchSearchMatches(new Map());
        }
      } catch (error) {
        if (searchGenerationRef.current !== generation) return;
        console.warn('Transcript search failed:', error);
        if (branchMode) setBranchSearchMatches(new Map());
        else setSearchMatchesByChat(new Map());
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [universalSearchQuery, branchMode, branchSearchChatId]);

  useEffect(() => { setSearchHitIndexByChat({}); setBranchSearchHitIndexById({}); }, [universalSearchQuery]);

  // Chat persistence is intentionally serialized per chat. A debounced streaming
  // snapshot must never finish *after* a newer boundary snapshot and overwrite it
  // on the server. `persistChatSnapshot` may be called often; the queue preserves
  // write order and the debounce keeps token streaming from becoming write-per-token.
  const chatSaveTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const chatSaveQueuesRef = useRef(new Map<string, Promise<void>>());

  const enqueueChatSave = (chat: Chat) => {
    const previous = chatSaveQueuesRef.current.get(chat.id) ?? Promise.resolve();
    const queued = previous
      .catch(() => { /* a failed older save must not block newer snapshots */ })
      .then(() => saveChat(chat));
    chatSaveQueuesRef.current.set(chat.id, queued);
    queued
      .catch((e) => console.warn('Failed to save chat:', e))
      .finally(() => {
        if (chatSaveQueuesRef.current.get(chat.id) === queued) {
          chatSaveQueuesRef.current.delete(chat.id);
        }
      });
  };

  const persistChatSnapshot = (chat: Chat, immediate = false) => {
    const previous = chatSaveTimersRef.current.get(chat.id);
    if (previous) clearTimeout(previous);
    if (immediate) {
      chatSaveTimersRef.current.delete(chat.id);
      enqueueChatSave(chat);
      return;
    }
    const timer = setTimeout(() => {
      chatSaveTimersRef.current.delete(chat.id);
      enqueueChatSave(chat);
    }, 175);
    chatSaveTimersRef.current.set(chat.id, timer);
  };

  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [questionBatch, setQuestionBatch] = useState<UserQuestionBatch | null>(null);
  const questionResolverRef = useRef<((answers: Record<string, UserQuestionAnswer>) => void) | null>(null);

  const resolveQuestionBatch = useCallback((answers: Record<string, UserQuestionAnswer>) => {
    const resolver = questionResolverRef.current;
    questionResolverRef.current = null;
    if (!resolver && questionBatch) {
      void vulcan.generalWS.send('runs/answer', {
        chat_id: questionBatch.chatId,
        batch_id: questionBatch.id,
        answers,
      }).catch((error) => toast.error(`Could not answer agent question: ${error.message}`));
    }
    setQuestionBatch(null);
    resolver?.(answers);
  }, [questionBatch]);

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
    const selected = providers.find((provider) => provider.id === saved.providerId) ?? providers[0];
    const config: LLMConfig = {
      baseUrl: selected?.baseUrl ?? saved.baseUrl ?? '',
      apiKey: selected?.apiKey ?? '',
      model: saved.model ?? '',
      providerId: selected?.id ?? saved.providerId,
    };
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
    if (!chat) return loadDefaultDisabledTools(activeVulcanEndpoint);
    return new Set(chat.disabledTools ?? []);
  };

  // Convenience derived values for the active chat
  const enabledKits = getActiveChatEnabledKits(activeChat);
  const disabledTools = getActiveChatDisabledTools(activeChat);

  // Sidebar collapsed state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  // Mirrors the live resizable sidebar width so the top-bar title can begin at
  // the exact same x-position as the chat pane. This is presentation-only state.
  const [sidebarSizePercent, setSidebarSizePercent] = useState(20);

  const enterDesignFocus = useCallback((designId: string) => {
    if (!designChromeRestoreRef.current) {
      designChromeRestoreRef.current = { sidebarCollapsed, artifactsPanelOpen };
    }
    setSidebarCollapsed(true);
    setArtifactsPanelOpen(false);
    setOpenDesignId(designId);
    setDesignOpen(true);
    requestAnimationFrame(() => designPanelRef.current?.expand());
  }, [artifactsPanelOpen, sidebarCollapsed]);

  const exitDesignFocus = useCallback(() => {
    setDesignOpen(false);
    setOpenDesignId(null);
    designPanelRef.current?.collapse();
    const restore = designChromeRestoreRef.current;
    designChromeRestoreRef.current = null;
    if (restore) {
      setSidebarCollapsed(restore.sidebarCollapsed);
      setArtifactsPanelOpen(restore.artifactsPanelOpen);
    }
  }, []);

  // Design visibility is presentation state. Switching chats exits the focused
  // Design workspace and restores the chrome that was visible before it opened.
  useEffect(() => {
    if (designChromeRestoreRef.current || designOpen || openDesignId) exitDesignFocus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id]);
  // AbortController for cancelling in-flight inference
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleStop = () => {
    abortControllerRef.current?.abort();
    const chatId = activeChatIdRef.current;
    if (!chatId) {
      setProcessing(false);
      return;
    }
    // Keep the composer locked until the server confirms that cancellation,
    // checkpoint/finalization, and chat ownership release are complete.
    void vulcan.generalWS.send('runs/cancel', { chat_id: chatId })
      .then(() => {
        if (activeChatIdRef.current === chatId) setProcessing(false);
      })
      .catch((error) => console.warn('Could not stop server-owned run:', error));
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

  const handleSelectTerminalSlot = useCallback(async (selected: TerminalSlotMeta) => {
    if (selected.status !== 'closed-inactivity') {
      setActiveTerminalSlot(selected);
      return;
    }
    try {
      const slot = await vulcan.openSlot(selected.chatId, selected.kind, selected.slot);
      const resumed: TerminalSlotMeta = {
        ...selected, slot, status: 'connected', generation: Date.now(),
      };
      setTerminalSlots((previous) => previous.map((item) => (
        item.kind === selected.kind && item.slot === selected.slot ? resumed : item
      )));
      if (selected.kind === 'agent') {
        openAgentSlotsRef.current = [...new Set([...openAgentSlotsRef.current, slot])].sort((a, b) => a - b);
      }
      setActiveTerminalSlot(resumed);
    } catch (error: any) {
      toast.error(error?.message ?? 'Could not resume terminal');
    }
  }, []);

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

  // An authenticated client viewing a persisted chat owns an idle-shutdown
  // lease for that chat's running container. This does not start a stopped
  // container and does not prevent an explicit manual stop.
  useEffect(() => {
    // The server scopes this lease to the general WebSocket session. Switching
    // chats replaces the lease atomically; disconnect cleanup releases it.
    void vulcan.setOpenChatPresence(workspaceChatId).catch(() => {});
  }, [workspaceChatId]);

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
          status: s.finished
            ? (s.close_reason === 'inactivity' ? 'closed-inactivity' : 'disconnected')
            : 'connected',
        }));
        setTerminalSlots(metas);
        openAgentSlotsRef.current = metas.filter((s) => s.kind === 'agent').map((s) => s.slot);
        // Default active slot: first agent slot, or first user slot, or null
        const firstAgent = metas.find((s) => s.kind === 'agent');
        const firstUser  = metas.find((s) => s.kind === 'user');
        const first = firstAgent ?? firstUser ?? null;
        setActiveTerminalSlot(first);

        // If the chat has no existing terminal slots, leave the workspace idle.
        // Opening/selecting a chat must not create a PTY; the user can explicitly
        // create one from the terminal bar when they actually need it.
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
    saveDefaultDisabledTools(activeVulcanEndpoint, next);
    // Update the active chat
    const updateChat = (c: Chat) => c.id === activeChat.id ? { ...c, disabledTools: nextArray } : c;
    if (pendingChat?.id === activeChat.id) {
      setPendingChat((p) => p ? { ...p, disabledTools: nextArray } : p);
    } else {
      setChats((prevChats) => prevChats.map((chat) => {
        const updated = updateChat(chat);
        if (updated !== chat) persistChatSnapshot(updated, true);
        return updated;
      }));
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

  const testInferenceConnection = useCallback(async () => {
    // Health checks can be triggered by startup, reconnect, settings changes and
    // the periodic probe. Collapse overlapping calls into one /models pass so a
    // slow provider never creates a polling thundering herd.
    if (providerHealthProbeRef.current) return providerHealthProbeRef.current;
    const probe = (async () => {
      const providers = loadProviders();
      if (providers.length === 0) {
        setProviderConnectionState('none');
        return false;
      }

      const results = await Promise.all(providers.map((provider) => testProviderConnection(provider)));
      const connectedCount = results.filter(Boolean).length;
      setProviderConnectionState(connectedCount === providers.length ? 'all' : connectedCount > 0 ? 'partial' : 'none');
      return connectedCount > 0;
    })();
    providerHealthProbeRef.current = probe;
    try {
      return await probe;
    } finally {
      if (providerHealthProbeRef.current === probe) providerHealthProbeRef.current = null;
    }
  }, []);

  const applyEtnaState = useCallback((state: any) => {
    const logical = (state?.kits ?? []) as LogicalEtnaKit[];
    const resolved = logical.filter((kit) => !kit.unresolved_conflict && kit.effective_source);
    setEtnaServers((state?.servers ?? []) as EtnaServerProfile[]);
    setEtnaLogicalKits(logical);
    const dynamicSkills = Array.isArray(state?.skills) ? state.skills : [];
    setEtnaSkillDescriptors(dynamicSkills);
    setSkills((previous) => dynamicSkills.filter((skill: any) => skill.source === 'skills').map((skill: any) => ({
      name: skill.name, stem: skill.name.toLowerCase().replace(/\s+/g, '-'), description: skill.description || '',
      source: skill.source,
      enabled: previous.find((item) => item.name === skill.name)?.enabled ?? !loadDisabledEtnaSkills().has(skill.name),
    })));
    setEtnaSummary((state?.summary ?? { servers: 0, kits: 0, tools: 0, healthy: 0, configured: 0, conflictServerIds: [] }) as EtnaSummary);
    toolSemanticIndexRef.current = state?.semanticToolIndex ?? null;
    const details: KitWithTools[] = resolved.map((kit) => ({
      kit_name: kit.kit_name, kit_description: kit.kit_description, filename: kit.filename,
      enabled: kit.enabled !== false, skill: kit.skill, tools: kit.tools ?? [],
      logical_id: kit.logical_id, effective_source: kit.effective_source, sources: kit.sources,
    } as KitWithTools));
    setKits(details.map(({ tools: _tools, ...kit }) => kit as Kit));
    kitToolsCacheRef.current = details;
    setKitsWithTools(details);
    setKitsLoaded(true);
    setConnected((state?.summary?.healthy ?? 0) > 0);
    return details;
  }, []);

  const loadKits = useCallback(async () => {
    setLoading(true);
    try {
      const state = await refreshEtnaState();
      const details = applyEtnaState(state);
      toast.success(`Loaded ${details.length} kits`);
      return details.map(({ tools: _tools, ...kit }) => kit as Kit);
    } catch {
      toast.error('Failed to load Etna servers');
      setConnected(false);
      return [];
    } finally { setLoading(false); }
  }, [applyEtnaState]);

  const loadTools = useCallback(async (_allKits: Kit[]) => {
    // Multi-Etna refresh already returns each deduplicated logical kit with its tools.
    setKitsWithTools(kitToolsCacheRef.current);
    setKitsLoaded(true);
  }, []);

  const hydrateServerOwnedStateFromServer = useCallback(async () => {
    if (vulcanServerSwitchingRef.current) return;
    const generation = serverContextGenerationRef.current;
    try {
      const [loadedChats, loadedFolders] = await Promise.all([loadChats(), loadChatFolders()]);
      if (serverContextGenerationRef.current !== generation || vulcanServerSwitchingRef.current) return;
      setChats(loadedChats);
      setChatFolders(loadedFolders);
      setChatIndexHydrated(true);
      // Provider/Etna definitions are client-owned and deliberately survive Vulcan server switches.
      const providers = loadProviders();
      const selected = providers.find((provider) => provider.id === llmClient.getConfig().providerId) ?? providers[0];
      if (selected) {
        const current = llmClient.getConfig();
        const config: LLMConfig = { ...current, baseUrl: selected.baseUrl, apiKey: selected.apiKey, providerId: selected.id };
        llmClient.setConfig(config);
        setLLMConfig(config);
      }
      void testInferenceConnection();
    } catch (error) {
      if (serverContextGenerationRef.current !== generation || vulcanServerSwitchingRef.current) return;
      console.warn('[Vulcan] Could not hydrate server-owned chat state:', error);
    }
  }, [testInferenceConnection]);

  useEffect(() => {
    const unsubscribe = vulcan.generalWS.onConnectionChange((connected) => {
      setVulcanConnected(connected);
      if (connected) void hydrateServerOwnedStateFromServer();
    });
    return unsubscribe;
  }, [hydrateServerOwnedStateFromServer]);

  useEffect(() => {
    const init = async () => {
      if (!vulcan.generalWS.connected || !vulcan.generalWS.authenticated) return;
      try { await vulcan.generalWS.send('client/register', { client_id: getEtnaClientDeviceId() }); } catch { return; }
      const loadedKits = await loadKits();
      await loadTools(loadedKits);
    };
    void init();
  }, [activeVulcanEndpoint, vulcanConnected, loadKits, loadTools]);

  useEffect(() => {
    if (!vulcanConnected) return;
    let cancelled = false;

    const poll = async () => {
      if (cancelled || etnaHealthProbeInFlightRef.current) return;
      etnaHealthProbeInFlightRef.current = true;
      try {
        const health = await probeEtnaHealth();
        if (cancelled) return;

        if (health.recoveredServerIds.length > 0) {
          // A recovery gets one full inventory refresh so newly added/removed kits are
          // reconciled immediately. This path is deliberately silent: background
          // health recovery must not spam the user with "Loaded X kits" toasts.
          const refreshed = await refreshEtnaState();
          if (!cancelled) applyEtnaState(refreshed);
        } else if (health.changed) {
          // Offline transitions only need the lightweight projection update. Preserve
          // last-known inventory while immediately graying connection indicators.
          applyEtnaState(health);
        }
      } catch (error) {
        console.warn('[Vulcan] Background Etna health probe failed', error);
      } finally {
        etnaHealthProbeInFlightRef.current = false;
      }
    };

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void poll();
    }, 10_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [vulcanConnected, applyEtnaState]);

  useEffect(() => vulcan.generalWS.onPush('push/etna-http-request', (payload: any) => {
    void (async () => {
      const relayId = payload?.relay_id;
      try {
        const url = String(payload.base_url || '').replace(/\/$/, '') + String(payload.path || '');
        const response = await fetch(url, {
          method: payload.method || 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: payload.body == null || (payload.method || 'GET') === 'GET' ? undefined : JSON.stringify(payload.body),
        });
        const text = await response.text();
        let data: any = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { result: text }; }
        if (!response.ok) throw new Error(`Etna HTTP ${response.status}: ${text || response.statusText}`);
        await vulcan.generalWS.push('etna/http-response', { relay_id: relayId, data });
      } catch (error: any) {
        await vulcan.generalWS.push('etna/http-response', { relay_id: relayId, error: error?.message ?? String(error) }).catch(() => {});
      }
    })();
  }), []);

  // Generic authenticated client-side HTTP transport. Client-POV Providers use
  // this for /models and streaming inference; cancellation aborts fetch immediately.
  useEffect(() => {
    const active = new Map<string, AbortController>();
    const offRequest = vulcan.generalWS.onPush('push/client-http-request', (payload: any) => {
      void (async () => {
        const relayId = String(payload?.relay_id || '');
        if (!relayId) return;
        const controller = new AbortController();
        active.set(relayId, controller);
        const timeoutMs = Math.max(1000, Number(payload?.timeout_ms || 30000));
        const timer = window.setTimeout(() => controller.abort(), timeoutMs);
        const emit = (event: Record<string, any>) =>
          vulcan.generalWS.push('client/http-event', { relay_id: relayId, ...event });

        // Browser fetch may expose very small transport chunks. Coalesce only a
        // couple of milliseconds worth so AES/JSON/WebSocket framing overhead
        // stays low without making token streaming feel buffered or remote.
        let chunkBuffer = '';
        let chunkTimer: number | null = null;
        let chunkSendChain = Promise.resolve();
        const flushChunks = () => {
          if (chunkTimer !== null) { window.clearTimeout(chunkTimer); chunkTimer = null; }
          if (!chunkBuffer) return chunkSendChain;
          const data = chunkBuffer;
          chunkBuffer = '';
          chunkSendChain = chunkSendChain.then(() =>
            vulcan.generalWS.push('client/http-chunk', { relay_id: relayId, data })
          );
          return chunkSendChain;
        };
        const emitChunk = (data: string) => {
          if (!data) return;
          chunkBuffer += data;
          if (chunkBuffer.length >= 8 * 1024) {
            void flushChunks();
          } else if (chunkTimer === null) {
            chunkTimer = window.setTimeout(() => { void flushChunks(); }, 2);
          }
        };
        try {
          const response = await fetch(String(payload.url || ''), {
            method: payload.method || 'GET',
            headers: payload.headers || {},
            body: payload.body == null || (payload.method || 'GET') === 'GET'
              ? undefined
              : (typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body)),
            signal: controller.signal,
            redirect: 'follow',
          });
          if (!payload.stream) {
            const text = await response.text();
            await emit({ event: 'response', status: response.status, headers: Object.fromEntries(response.headers.entries()), text });
            return;
          }
          await emit({ event: 'headers', status: response.status, headers: Object.fromEntries(response.headers.entries()) });
          if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              const data = decoder.decode(value, { stream: true });
              if (data) emitChunk(data);
            }
            const tail = decoder.decode();
            if (tail) emitChunk(tail);
          }
          await flushChunks();
          await emit({ event: 'done' });
        } catch (error: any) {
          const message = error?.name === 'AbortError' ? 'Client HTTP request cancelled' : (error?.message ?? String(error));
          await emit({ event: 'error', error: message }).catch(() => {});
        } finally {
          window.clearTimeout(timer);
          active.delete(relayId);
        }
      })();
    });
    const offCancel = vulcan.generalWS.onPush('push/client-http-cancel', (payload: any) => {
      active.get(String(payload?.relay_id || ''))?.abort();
    });
    return () => {
      offRequest();
      offCancel();
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);

  useEffect(() => {
    if (!vulcanConnected) return;
    const refreshProviderStatus = () => {
      if (document.visibilityState !== 'hidden') void testInferenceConnection();
    };
    window.addEventListener('vulcan:providers-changed', refreshProviderStatus);
    const timer = window.setInterval(refreshProviderStatus, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void testInferenceConnection();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('vulcan:providers-changed', refreshProviderStatus);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [vulcanConnected, testInferenceConnection]);

  // Topic extraction is server-owned and asynchronous; keep its tiny projection
  // current without reloading transcripts or allowing an old server to bleed over.
  useEffect(() => {
    let cancelled = false;
    const refreshTopics = () => {
      const generation = serverContextGenerationRef.current;
      void vulcan.loadChatTopics().then((mapping) => {
        if (cancelled || serverContextGenerationRef.current !== generation) return;
        const merge = (chat: Chat): Chat => {
          const next = mapping[chat.id] ?? [];
          const previous = chat.tags ?? [];
          return next.length === previous.length && next.every((tag, index) => tag === previous[index])
            ? chat
            : { ...chat, tags: next };
        };
        setChats((previous) => {
          let changed = false;
          const next = previous.map((chat) => {
            const updated = merge(chat);
            if (updated !== chat) changed = true;
            return updated;
          });
          return changed ? next : previous;
        });
        setActiveChat((previous) => previous ? merge(previous) : previous);
      }).catch(() => { /* reconnects and server switches own their normal recovery */ });
    };
    refreshTopics();
    const interval = window.setInterval(refreshTopics, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeVulcanEndpoint]);

  // ── Chat management ────────────────────────────────────────────────────────

  // Create a new pending chat (not in sidebar yet)
  const handleNewChat = () => {
    // Only snapshot kit/tool defaults after kits have loaded — prevents the race
    // condition where the initial chat gets permanently pinned to an empty kit config
    const defaultEnabledKitNames = kitsLoaded
      ? (loadDefaultEnabledKits(activeVulcanEndpoint) ?? kits.filter((k) => k.enabled).map((k) => k.kit_name))
      : undefined;
    const defaultDisabledToolsArray = kitsLoaded
      ? Array.from(loadDefaultDisabledTools(activeVulcanEndpoint))
      : undefined;

    const newChat: Chat = {
      schemaVersion: 2,
      id: Date.now().toString(),
      title: '',
      events: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(defaultEnabledKitNames !== undefined ? { enabledKits: defaultEnabledKitNames } : {}),
      ...(defaultDisabledToolsArray !== undefined ? { disabledTools: defaultDisabledToolsArray } : {}),
    };
    pendingChatIdRef.current = newChat.id;
    setPendingChat(newChat);
    setActiveChat(newChat);
    setPanels([]);
    setPresentedFiles([]);
    setAttachments([]);
    setBranchMode(false);
    setSelectedBranchId(null);
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
    const generation = ++chatSelectionGenerationRef.current;
    const candidate = chats.find((c) => c.id === chatId);
    if (!candidate) return;

    void (async () => {
      let chat = candidate;
      if (candidate._summaryOnly) {
        const hydrated = await loadChat(chatId);
        if (!hydrated || generation !== chatSelectionGenerationRef.current) return;
        chat = hydrated;
        setChats((previous) => previous.map((item) => item.id === chatId ? hydrated : item));
      }
      if (generation !== chatSelectionGenerationRef.current) return;
      setActiveChat(chat);
      pendingChatIdRef.current = null;
      setPendingChat(null);
      const assets = projectWorkspaceAssets(chat.events);
      setPresentedFiles(assets.presentedFiles);
      setPanels(assets.panels);
      setAttachments([]);
      setBranchMode(false);
      setSelectedBranchId(null);
    })();
  };

  useEffect(() => {
    const desktop = (window as any).electronAPI?.desktop;
    if (typeof desktop?.onOpenChat !== 'function') return;
    return desktop.onOpenChat((chatId: string) => handleSelectChat(String(chatId)));
  }, [chats]);

  const searchHitIndex = (chatId: string): number => {
    const matches = searchMatchesByChat.get(chatId) ?? [];
    if (!matches.length) return 0;
    return clampSearchIndex(searchHitIndexByChat[chatId], matches.length);
  };

  const navigateSearchHit = (chatId: string, delta: number) => {
    const matches = searchMatchesByChat.get(chatId) ?? [];
    if (!matches.length) return;
    const next = advanceSearchIndex(searchHitIndexByChat[chatId], matches.length, delta);
    setSearchHitIndexByChat((indexes) => ({ ...indexes, [chatId]: next }));
    if (activeChatIdRef.current !== chatId) handleSelectChat(chatId);
  };

  const selectSearchHit = (chatId: string, index: number) => {
    const matches = searchMatchesByChat.get(chatId) ?? [];
    if (!matches.length) return;
    const next = clampSearchIndex(index, matches.length);
    setSearchHitIndexByChat((indexes) => ({ ...indexes, [chatId]: next }));
    if (activeChatIdRef.current !== chatId) handleSelectChat(chatId);
  };

  const branchSearchHitIndex = (branchId: string): number => {
    const matches = branchSearchMatches.get(branchId) ?? [];
    return matches.length ? clampSearchIndex(branchSearchHitIndexById[branchId], matches.length) : 0;
  };

  const selectBranch = (branchId: string) => {
    setSelectedBranchId(branchId);
  };

  const navigateBranchSearchHit = (branchId: string, delta: number) => {
    const matches = branchSearchMatches.get(branchId) ?? [];
    if (!matches.length) return;
    setSelectedBranchId(branchId);
    setBranchSearchHitIndexById((indexes) => ({ ...indexes, [branchId]: advanceSearchIndex(indexes[branchId], matches.length, delta) }));
  };

  const selectBranchSearchHit = (branchId: string, index: number) => {
    const matches = branchSearchMatches.get(branchId) ?? [];
    if (!matches.length) return;
    setSelectedBranchId(branchId);
    setBranchSearchHitIndexById((indexes) => ({ ...indexes, [branchId]: clampSearchIndex(index, matches.length) }));
  };

  const handleRenameBranch = (branchId: string, title: string) => {
    if (!activeChat) return;
    const next = renameBranch(activeChat, branchId, title);
    setActiveChat(next);
    setChats((previous) => previous.map((chat) => chat.id === next.id ? next : chat));
    persistChatSnapshot(next, true);
  };

  const toggleBranchMode = () => {
    if (!activeChat || activeChat.events.length === 0) return;
    setBranchMode((open) => {
      const next = !open;
      if (next) setSelectedBranchId(ensureBranching(activeChat).currentBranchId);
      return next;
    });
  };

  const navigateSearchChat = (delta: number) => {
    if (!orderedSearchChatIds.length) return;
    const nextChatId = advanceSearchChatId(orderedSearchChatIds, activeChatIdRef.current, delta);
    if (nextChatId) handleSelectChat(nextChatId);
  };

  const handleUniversalSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (branchMode) {
        const ordered = [...activeBranches]
          .filter((branch) => branch.title.toLocaleLowerCase().includes(universalSearchQuery.trim().toLocaleLowerCase()) || (branchSearchMatches.get(branch.id)?.length ?? 0) > 0)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        if (!ordered.length) return;
        const selectedIndex = ordered.findIndex((branch) => branch.id === effectiveSelectedBranchId);
        if (event.ctrlKey || event.metaKey) {
          const delta = event.shiftKey ? -1 : 1;
          const base = selectedIndex >= 0 ? selectedIndex : (delta > 0 ? -1 : 0);
          setSelectedBranchId(ordered[(base + delta + ordered.length) % ordered.length].id);
          return;
        }
        const branchId = effectiveSelectedBranchId ?? ordered[0].id;
        const matches = branchSearchMatches.get(branchId) ?? [];
        if (matches.length) navigateBranchSearchHit(branchId, event.shiftKey ? -1 : 1);
        else setSelectedBranchId(ordered[0].id);
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        if (orderedSearchChatIds.length) navigateSearchChat(event.shiftKey ? -1 : 1);
        return;
      }
      const currentId = activeChatIdRef.current;
      const currentMatches = currentId ? (searchMatchesByChat.get(currentId) ?? []) : [];
      if (currentId && currentMatches.length) navigateSearchHit(currentId, event.shiftKey ? -1 : 1);
      else if (orderedSearchChatIds.length) handleSelectChat(orderedSearchChatIds[0]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setUniversalSearchQuery('');
      event.currentTarget.blur();
    }
  };

  useEffect(() => {
    const ownsFind = (target: EventTarget | null): boolean => {
      const element = target instanceof Element ? target : null;
      return Boolean(element?.closest('.monaco-editor, .xterm, [data-vulcan-native-find]'));
    };
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || ownsFind(event.target)) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (sidebarCollapsed) setSidebarCollapsed(false);
        window.setTimeout(() => { universalSearchInputRef.current?.focus(); universalSearchInputRef.current?.select(); }, 0);
        return;
      }
      if (event.key === 'Escape' && universalSearchQuery.trim()) {
        const element = event.target instanceof HTMLElement ? event.target : null;
        const isEditingElsewhere = element !== universalSearchInputRef.current
          && Boolean(element?.closest('input, textarea, [contenteditable="true"]'));
        if (!isEditingElsewhere) {
          event.preventDefault();
          setUniversalSearchQuery('');
          universalSearchInputRef.current?.blur();
          return;
        }
      }
      if (event.key === 'Enter' && modifier && !event.altKey) {
        const element = event.target instanceof HTMLElement ? event.target : null;
        const isEditingElsewhere = element !== universalSearchInputRef.current
          && Boolean(element?.closest('input, textarea, [contenteditable="true"]'));
        if (isEditingElsewhere || !universalSearchQuery.trim()) return;
        if (branchMode) {
          const ordered = [...activeBranches]
            .filter((branch) => branch.title.toLocaleLowerCase().includes(universalSearchQuery.trim().toLocaleLowerCase()) || (branchSearchMatches.get(branch.id)?.length ?? 0) > 0)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          if (!ordered.length) return;
          const index = ordered.findIndex((branch) => branch.id === effectiveSelectedBranchId);
          const delta = event.shiftKey ? -1 : 1;
          const base = index >= 0 ? index : (delta > 0 ? -1 : 0);
          event.preventDefault();
          setSelectedBranchId(ordered[(base + delta + ordered.length) % ordered.length].id);
          return;
        }
        if (!orderedSearchChatIds.length) return;
        event.preventDefault();
        navigateSearchChat(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'F3' && (event.ctrlKey || event.metaKey)) {
        if (!universalSearchQuery.trim()) return;
        if (branchMode) {
          const ordered = [...activeBranches]
            .filter((branch) => branch.title.toLocaleLowerCase().includes(universalSearchQuery.trim().toLocaleLowerCase()) || (branchSearchMatches.get(branch.id)?.length ?? 0) > 0)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          if (!ordered.length) return;
          const index = ordered.findIndex((branch) => branch.id === effectiveSelectedBranchId);
          const delta = event.shiftKey ? -1 : 1;
          const base = index >= 0 ? index : (delta > 0 ? -1 : 0);
          event.preventDefault();
          setSelectedBranchId(ordered[(base + delta + ordered.length) % ordered.length].id);
          return;
        }
        if (!orderedSearchChatIds.length) return;
        event.preventDefault();
        navigateSearchChat(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (!universalSearchQuery.trim()) return;
        if (branchMode && effectiveSelectedBranchId && (branchSearchMatches.get(effectiveSelectedBranchId)?.length ?? 0) > 0) {
          event.preventDefault();
          navigateBranchSearchHit(effectiveSelectedBranchId, event.shiftKey ? -1 : 1);
          return;
        }
        const currentId = activeChatIdRef.current;
        if (!currentId || !(searchMatchesByChat.get(currentId)?.length)) return;
        event.preventDefault();
        navigateSearchHit(currentId, event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sidebarCollapsed, universalSearchQuery, orderedSearchChatIds, searchMatchesByChat, searchHitIndexByChat, branchMode, activeBranches, branchSearchMatches, effectiveSelectedBranchId, branchSearchHitIndexById]);

  // Server-owned agent runs update canonical asset events over WebSocket. Project
  // those typed events immediately, then reconcile dashboards against the actual
  // server inventory so historical panel events cannot revive deleted dashboards.
  useEffect(() => {
    if (!activeChat) {
      setPresentedFiles([]);
      setPanels([]);
      return;
    }

    const chatId = activeChat.id;
    const events = activeChat.events;
    const assets = projectWorkspaceAssets(events);
    setPresentedFiles(assets.presentedFiles);
    setPanels(assets.panels);

    if (pendingChatIdRef.current === chatId) return;
    const generation = serverContextGenerationRef.current;
    let cancelled = false;

    void vulcan.dashboardList(chatId).then((dashboards) => {
      if (cancelled || activeChatIdRef.current !== chatId || serverContextGenerationRef.current !== generation) return;
      setPanels(reconcileDashboardInventory(events, dashboards));
    }).catch(() => {
      // The typed event projection remains available if the server disconnects.
    });

    return () => { cancelled = true; };
  // Ordinary streamed text does not change this revision or poll the dashboard inventory.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id, activeWorkspaceAssetRevision, activeVulcanEndpoint]);

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
    const pendingTimer = chatSaveTimersRef.current.get(chatId);
    if (pendingTimer) clearTimeout(pendingTimer);
    chatSaveTimersRef.current.delete(chatId);
    // Deletion is sequenced after any already in-flight save so an old write cannot
    // finish later and resurrect the chat.json we just deleted.
    const priorSave = chatSaveQueuesRef.current.get(chatId) ?? Promise.resolve();
    priorSave
      .catch(() => { /* deletion should still proceed after a failed save */ })
      .then(() => deleteChat(chatId))
      .catch((e) => console.warn('Failed to delete chat remotely:', e));
    toast.success('Chat deleted');
  };

  const handleRenameChat = (chatId: string, title: string) => {
    setChats((prev) => prev.map((c) => {
      if (c.id !== chatId) return c;
      // Sidebar recency tracks chat activity, not metadata edits such as renaming.
      const renamed = { ...c, title };
      persistChatSnapshot(renamed, true);
      return renamed;
    }));
    if (activeChat?.id === chatId) {
      setActiveChat((prev) => (prev ? { ...prev, title } : null));
    }
    toast.success('Chat renamed');
  };

  const handleDownloadChat = async (chatId: string) => {
    try {
      const response = await vulcan.generalWS.send('chats/export', { chat_id: chatId });
      const chat = response.chat;
      const title = String(chat.title || 'chat').trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'chat';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const blob = new Blob([JSON.stringify(chat, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${title}-${timestamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Chat JSON downloaded');
    } catch (error: any) {
      toast.error(`Could not export chat: ${error?.message ?? String(error)}`);
    }
  };

  const handleNewFolder = () => {
    const folder: ChatFolder = {
      id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: 'New Folder',
      parentId: null,
      createdAt: new Date(),
      collapsed: false,
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
    promotedChats.filter((c, i) => c !== chats[i]).forEach((c) => persistChatSnapshot(c, true));
    saveChatFolders(nextFolders).catch((e) => console.warn('Failed to delete chat folder:', e));
    toast.success('Folder deleted');
  };

  const handleMoveSidebarItem = (item: SidebarDragItem, parentFolderId: string | null, expandFolderId?: string) => {
    if (parentFolderId) {
      const parent = chatFolders.find((f) => f.id === parentFolderId);
      if (!parent) return;
    }

    // Folder topology is still draggable, but sibling ordering is automatic.
    // Prevent moving a folder into itself or one of its descendants.
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

    if (item.type === 'chat') {
      const current = chats.find((c) => c.id === item.id);
      if (!current || (current.folderId ?? null) === parentFolderId) return;
      const moved = { ...current, folderId: parentFolderId };
      setChats((prev) => prev.map((c) => c.id === item.id ? moved : c));
      if (activeChat?.id === item.id) setActiveChat((prev) => prev ? { ...prev, folderId: parentFolderId } : prev);
      persistChatSnapshot(moved, true);
    } else {
      const current = chatFolders.find((f) => f.id === item.id);
      if (!current || (current.parentId ?? null) === parentFolderId) {
        if (expandFolderId) {
          const expanded = chatFolders.map((f) => f.id === expandFolderId ? { ...f, collapsed: false } : f);
          setChatFolders(expanded);
          saveChatFolders(expanded).catch((e) => console.warn('Failed to expand chat folder:', e));
        }
        return;
      }
      const nextFolders = chatFolders.map((f) => {
        let next = f.id === item.id ? { ...f, parentId: parentFolderId } : f;
        if (expandFolderId && f.id === expandFolderId) next = { ...next, collapsed: false };
        return next;
      });
      setChatFolders(nextFolders);
      saveChatFolders(nextFolders).catch((e) => console.warn('Failed to save moved folder:', e));
      return;
    }

    if (expandFolderId) {
      const nextFolders = chatFolders.map((f) => f.id === expandFolderId ? { ...f, collapsed: false } : f);
      setChatFolders(nextFolders);
      saveChatFolders(nextFolders).catch((e) => console.warn('Failed to expand chat folder:', e));
    }
  };

  const handleVulcanSettingsChange = (partial: Partial<VulcanSettings>) => {
    setVulcanSettings((prev) => {
      const next = { ...prev, ...partial };
      saveVulcanSettings(next);
      return next;
    });
  };

  const handleSwitchVulcanServer = async (profile: VulcanServerProfile): Promise<void> => {
    if (profile.url === activeVulcanEndpoint || vulcanServerSwitchingRef.current) return;
    vulcanServerSwitchingRef.current = true;
    setIsSwitchingVulcanServer(true);

    type HydratedServerContext = {
      chats: Chat[];
      folders: ChatFolder[];
      providers: ProviderConfig[];
      current: { base_url?: string; model?: string; provider_id?: string };
    };

    try {
      await transitionVulcanServer<HydratedServerContext>({
        previousUrl: activeVulcanEndpoint,
        targetUrl: profile.url,
        probe: async (url) => withServerSwitchProbeDeadline(url, async (signal) => {
          // These checks are independent and share one short pre-detach deadline.
          // Parallelizing them saves a round trip on healthy remote servers while
          // AbortController guarantees a black-holed route fails on Vulcan's
          // schedule rather than the browser/OS TCP timeout.
          const [response, authResponse, metaResponse] = await Promise.all([
            fetch(`${url}/ping`, { signal }),
            fetch(`${url}/auth/status`, { signal }),
            fetch(`${url}/meta`, { signal }),
          ]);
          if (!response.ok) throw new Error(`Server is unavailable (${response.status}).`);
          if (!metaResponse.ok) {
            throw new Error('Selected Vulcan server is too old for this client (missing /meta compatibility endpoint).');
          }
          assertCompatibleVulcanMeta(await metaResponse.json());

          // /ping is intentionally public, so it cannot establish that this
          // client is allowed to open the protected general WebSocket. Check
          // the public auth status before detaching the currently usable server.
          if (authResponse.ok) {
            const status = await authResponse.json() as {
              requires_auth?: boolean;
              remote_access_allowed?: boolean;
            };
            const remoteAccessBlocked = status.remote_access_allowed === false
              || (
                status.remote_access_allowed == null
                && status.requires_auth === false
                && !isLoopbackVulcanServerUrl(url)
              );
            if (remoteAccessBlocked) {
              throw new Error(
                'Remote Vulcan servers require a server password. '
                + 'Run vulcan set-password on the selected server, then switch again.',
              );
            }
          }
        }),
        flush: async () => {
          for (const [chatId, timer] of chatSaveTimersRef.current) {
            clearTimeout(timer);
            chatSaveTimersRef.current.delete(chatId);
            const latest = activeChat?.id === chatId
              ? activeChat
              : chats.find((chat) => chat.id === chatId);
            if (latest && pendingChatIdRef.current !== chatId) enqueueChatSave(latest);
          }
          await Promise.all([...chatSaveQueuesRef.current.values()]);
        },
        detach: () => {
          serverContextGenerationRef.current += 1;
          window.dispatchEvent(new CustomEvent('vulcan:server-switching'));
          activeChatIdRef.current = null;
          pendingChatIdRef.current = null;
          focusedAgentSlotRef.current = null;
          openAgentSlotsRef.current = [];
          questionResolverRef.current = null;
          setChats([]);
          setChatFolders([]);
          setChatIndexHydrated(false);
          setActiveChat(null);
          setPendingChat(null);
          setProcessing(false);
          setQuestionBatch(null);
          setPresentedFiles([]);
          setPresentedFilePath(null);
          setOpenPanelName(null);
          setPanels([]);
          setAttachments([]);
          setTerminalSlots([]);
          setTerminalChatStatuses({});
          setActiveTerminalSlot(null);
          setFocusedAgentSlot(null);
          setAgentRunningSlot(null);
          setProviderConnectionState('none');
          cacheServerProviders([]);
        },
        connect: (url) => {
          saveVulcanEndpoint(url);
          setGeneralWSBaseUrl(getVulcanWsBaseUrl());
        },
        hydrate: async () => {
          const [serverChats, folders] = await Promise.all([loadChats(), loadChatFolders()]);
          return { chats: serverChats, folders };
        },
        commit: (url, context) => {
          // Provider and Etna definitions are client-owned and scoped by Vulcan
          // endpoint; changing the endpoint selects this client's profile set for it.
          setChats(context.chats);
          setChatFolders(context.folders);
          setChatIndexHydrated(true);
          setActiveVulcanEndpoint(url);
          const scopedProviders = loadProviders();
          const savedLLM = loadLLMConfig();
          const selectedProvider = scopedProviders.find((provider) => provider.id === savedLLM.providerId) ?? scopedProviders[0];
          const scopedLLM: LLMConfig = {
            baseUrl: selectedProvider?.baseUrl ?? savedLLM.baseUrl ?? '',
            apiKey: selectedProvider?.apiKey ?? '',
            model: loadSelectedModel() ?? savedLLM.model ?? '',
            providerId: selectedProvider?.id ?? savedLLM.providerId,
          };
          llmClient.setConfig(scopedLLM);
          setLLMConfig(scopedLLM);
          setSelectedModel(scopedLLM.model ?? '');
          // Clear the previous endpoint's Etna projection immediately; refresh below
          // reconstructs it only from this client's profiles for the new endpoint.
          setEtnaServers(loadEtnaServers());
          setEtnaLogicalKits([]);
          setEtnaSkillDescriptors([]);
          toolSemanticIndexRef.current = null;
          setEtnaSummary({ servers: 0, kits: 0, tools: 0, healthy: 0, configured: 0, conflictServerIds: [] });
          setKits([]);
          setKitsWithTools([]);
          kitToolsCacheRef.current = [];
          setKitsLoaded(false);
          void refreshEtnaState().then(applyEtnaState).catch(() => setConnected(false));
          // A server switch must enter the exact same backed new-chat state as
          // pressing the New Chat button. Leaving activeChat/pendingChat null only
          // makes the UI look like a new chat while handleSendMessage has no target.
          handleNewChat();
          void testInferenceConnection();
        },
      });
      toast.success(`Connected to ${profile.name}`);
    } catch (error: any) {
      toast.error(`Could not switch Vulcan servers: ${error?.message ?? String(error)}`);
      throw error;
    } finally {
      vulcanServerSwitchingRef.current = false;
      setIsSwitchingVulcanServer(false);
    }
  };

  const handleToggleKit = async (kitName: string, enabled: boolean) => {
    // Update per-chat enabledKits
    const prevEnabled = getActiveChatEnabledKits(activeChat);
    const nextEnabled = enabled
      ? [...prevEnabled.filter((k) => k !== kitName), kitName]
      : prevEnabled.filter((k) => k !== kitName);

    // Save as default for future chats
    saveDefaultEnabledKits(activeVulcanEndpoint, nextEnabled);

    // Update active chat
    const updateChat = (c: Chat) =>
      c.id === activeChat?.id ? { ...c, enabledKits: nextEnabled } : c;
    if (pendingChat?.id === activeChat?.id) {
      setPendingChat((p) => p ? { ...p, enabledKits: nextEnabled } : p);
    } else {
      setChats((prevChats) => prevChats.map((chat) => {
        const updated = updateChat(chat);
        if (updated !== chat) persistChatSnapshot(updated, true);
        return updated;
      }));
    }
    setActiveChat((prev) => prev ? { ...prev, enabledKits: nextEnabled } : prev);

    // Keep kitsWithTools as the full cache — filtering by enabled state happens in getAllTools()
    // at inference time. Filtering here causes the Kits tab to lose tool data on toggle.
    setKitsWithTools(kitToolsCacheRef.current);

    toast.success(`${kitName} ${enabled ? 'enabled' : 'disabled'}`);
  };

  const handleToggleSkill = (stem: string, enabled: boolean) => {
    const builtin = BUILTIN_SKILLS.find((skill) => `vulcan:${skill.name}` === stem);
    if (builtin) {
      const disabled = new Set(vulcanSettings.disabledVulcanSkills);
      if (enabled) disabled.delete(builtin.name);
      else disabled.add(builtin.name);
      handleVulcanSettingsChange({ disabledVulcanSkills: Array.from(disabled) });
      return;
    }
    setSkills((prev) => {
      const target = prev.find((skill) => skill.stem === stem);
      if (!target) return prev;
      const disabled = loadDisabledEtnaSkills();
      if (enabled) disabled.delete(target.name);
      else disabled.add(target.name);
      if (!saveDisabledEtnaSkills(disabled)) {
        toast.error('Could not save Etna skill setting');
        return prev;
      }
      return prev.map((skill) => skill.stem === stem ? { ...skill, enabled } : skill);
    });
  };

  const handleRefresh = async () => {
    const loadedKits = await loadKits();
    await loadTools(loadedKits);
  };

  // ── Canonical transcript helpers ───────────────────────────────────────────
  // The ordered ChatEvent[] is simultaneously the live transcript and the durable
  // transcript. Streaming mutates only the current event's contents; event positions
  // never move. Disk writes are debounced while tokens are arriving, then flushed on
  // semantic boundaries (tool result, turn completion, stop/error, etc.).

  const updateChatEvents = (chatId: string, events: ChatEvent[], fallback?: Chat, immediate = false, persist = true) => {
    const updatedAt = new Date();
    const withEvents = (chat: Chat): Chat => {
      const base = { ...chat, events, updatedAt };
      return chat.branching ? syncCurrentBranch(base, events) : base;
    };
    if (pendingChatIdRef.current === chatId) {
      setPendingChat((prev) => prev?.id === chatId ? withEvents(prev) : prev);
    } else {
      setChats((prev) => {
        let persisted: Chat | null = null;
        const next = prev.map((c) => {
          if (c.id !== chatId) return c;
          persisted = withEvents(c);
          return persisted;
        });
        if (!persisted && fallback) {
          persisted = withEvents(fallback);
          next.unshift(persisted);
        }
        if (persisted && persist) persistChatSnapshot(persisted, immediate);
        return next;
      });
    }
    setActiveChat((prev) => prev?.id === chatId ? withEvents(prev) : prev);
  };


  const replaceDesigns = useCallback((chatId: string, designs: DesignAttachment[]) => {
    designsByChatRef.current[chatId] = designs;
    const now = new Date();
    const merge = (chat: Chat): Chat => chat.id === chatId ? { ...chat, designs, updatedAt: now } : chat;
    if (pendingChatIdRef.current === chatId) {
      setPendingChat((previousChat) => previousChat ? merge(previousChat) : previousChat);
    } else {
      setChats((previousChats) => {
        let persisted: Chat | null = null;
        const next = previousChats.map((chat) => {
          const merged = merge(chat);
          if (merged !== chat) persisted = merged;
          return merged;
        });
        if (persisted) persistChatSnapshot(persisted, true);
        return next;
      });
    }
    setActiveChat((previousChat) => previousChat ? merge(previousChat) : previousChat);
  }, []);

  const chatForDesign = useCallback((chatId: string): Chat | null => (
    (activeChat?.id === chatId ? activeChat : chatsRef.current.find((chat) => chat.id === chatId))
      ?? (pendingChat?.id === chatId ? pendingChat : null)
  ), [activeChat, pendingChat]);

  const registerDesign = useCallback((chatId: string, requestedName: string, rawUrl: string) => {
    const chat = chatForDesign(chatId);
    if (!chat) return { error: 'chat_not_found', chatId };
    const name = requestedName.trim();
    const url = normalizeDesignUrl(rawUrl);
    if (!name || !url) return { error: 'invalid_design', message: 'Design requires a name and a valid HTTP or HTTPS URL.' };
    const designs = designsByChatRef.current[chatId] ?? chat.designs ?? [];
    if (designs.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return { error: 'design_already_exists', name };
    }
    const now = new Date();
    const design: DesignAttachment = {
      version: 1,
      id: `design-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
      name,
      url,
      attachedAt: now,
      updatedAt: now,
    };
    replaceDesigns(chatId, [...designs, design]);
    return { ok: true, design };
  }, [chatForDesign, replaceDesigns]);

  const updateDesign = useCallback((chatId: string, requestedName: string, rawUrl: string) => {
    const chat = chatForDesign(chatId);
    if (!chat) return { error: 'chat_not_found', chatId };
    const name = requestedName.trim();
    const url = normalizeDesignUrl(rawUrl);
    if (!url) return { error: 'invalid_design_url', name };
    const designs = designsByChatRef.current[chatId] ?? chat.designs ?? [];
    const existing = designs.find((item) => item.name === name);
    if (!existing) return { error: 'design_not_found', name };
    const updated: DesignAttachment = { ...existing, url, updatedAt: new Date() };
    replaceDesigns(chatId, designs.map((item) => item.id === existing.id ? updated : item));
    return { ok: true, design: updated };
  }, [chatForDesign, replaceDesigns]);

  const designInfo = useCallback((chatId: string, requestedName: string) => {
    const chat = chatForDesign(chatId);
    if (!chat) return { error: 'chat_not_found', chatId };
    const name = requestedName.trim();
    const design = (designsByChatRef.current[chatId] ?? chat.designs ?? []).find((item) => item.name === name);
    return design ? { ok: true, design } : { error: 'design_not_found', name };
  }, [chatForDesign]);

  const designList = useCallback((chatId: string) => {
    const chat = chatForDesign(chatId);
    if (!chat) return { error: 'chat_not_found', chatId };
    return { designs: designsByChatRef.current[chatId] ?? chat.designs ?? [] };
  }, [chatForDesign]);

  const removeDesign = useCallback((chatId: string, requestedName: string) => {
    const chat = chatForDesign(chatId);
    if (!chat) return { error: 'chat_not_found', chatId };
    const name = requestedName.trim();
    const currentDesigns = designsByChatRef.current[chatId] ?? chat.designs ?? [];
    const existing = currentDesigns.find((item) => item.name === name);
    if (!existing) return { error: 'design_not_found', name };
    replaceDesigns(chatId, currentDesigns.filter((item) => item.id !== existing.id));
    if (openDesignId === existing.id) {
      exitDesignFocus();
    }
    return { ok: true, removed: name, id: existing.id };
  }, [chatForDesign, exitDesignFocus, openDesignId, replaceDesigns]);

  const showDesign = useCallback((chatId: string, requestedName: string) => {
    const chat = chatForDesign(chatId);
    if (!chat) return { error: 'chat_not_found', chatId };
    const name = requestedName.trim();
    const design = (designsByChatRef.current[chatId] ?? chat.designs ?? []).find((item) => item.name === name);
    if (!design) return { error: 'design_not_found', name };
    enterDesignFocus(design.id);
    return { ok: true, designId: design.id, name: design.name, url: design.url, surface: 'open' };
  }, [chatForDesign, enterDesignFocus]);

  useEffect(() => {
    const handler = (event: Event) => {
      const { name } = (event as CustomEvent).detail ?? {};
      const chatId = activeChatIdRef.current;
      if (chatId && typeof name === 'string' && name.trim()) showDesign(chatId, name);
    };
    window.addEventListener('vulcan:open-design', handler);
    return () => window.removeEventListener('vulcan:open-design', handler);
  }, [showDesign]);


  useEffect(() => {
    if (!vulcanConnected) return;
    void vulcan.generalWS.push('client/state', {
      client_id: getEtnaClientDeviceId(),
      key: 'design_surface',
      value: {
        chat_id: activeChat?.id ?? null,
        open: Boolean(openDesignId && activeChat),
        design_id: activeChat ? openDesignId : null,
      },
    });
  }, [vulcanConnected, activeChat?.id, openDesignId]);

  useEffect(() => vulcan.generalWS.onPush('push/design-action-request', (payload: any) => {
    void (async () => {
      const waitForDesignSurfaceReady = async (timeoutMs = 15000, expected?: { designId?: string; targetUrl?: string }) => {
        const matchesExpectedSurface = () => {
          const surface = designSurfaceRef.current;
          if (!surface?.isReady()) return false;
          if (!expected?.designId && !expected?.targetUrl) return true;
          const identity = surface.getIdentity();
          if (expected.designId && identity.designId !== expected.designId) return false;
          if (expected.targetUrl && identity.targetUrl !== expected.targetUrl) return false;
          return true;
        };
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (matchesExpectedSurface()) return true;
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        return matchesExpectedSurface();
      };
      const relayId = String(payload?.relay_id || '');
      if (!relayId) return;
      const respond = (body: Record<string, any>) =>
        vulcan.generalWS.push('design/action-response', { relay_id: relayId, ...body });
      try {
        const chatId = String(payload?.chat_id || '');
        if (!chatId || chatId !== activeChatIdRef.current) throw new Error('design_surface_chat_not_active');
        const action = String(payload?.action || '');
        let data: unknown;
        if (action === 'status') {
          const identity = designSurfaceRef.current?.getIdentity();
          data = {
            open: Boolean(openDesignId),
            ready: Boolean(designSurfaceRef.current?.isReady()),
            design_id: identity?.designId ?? openDesignId,
            target_url: identity?.targetUrl ?? null,
          };
        } else if (action === 'open') {
          const rawDesign = payload?.design;
          if (rawDesign?.id && rawDesign?.url) {
            const design: DesignAttachment = {
              ...rawDesign,
              attachedAt: new Date(rawDesign.attachedAt),
              updatedAt: new Date(rawDesign.updatedAt ?? rawDesign.attachedAt),
            };
            const current = designsByChatRef.current[chatId] ?? [];
            // `open_design` is also a synchronization point. The server-owned
            // registry may have updated the URL for an already-known Design;
            // replace that record instead of keeping a stale client copy merely
            // because the id matches. Otherwise the pane can look healthy while
            // Electron transport has rebound to a different private origin.
            const existingIndex = current.findIndex((item) => item.id === design.id);
            const designs = existingIndex >= 0
              ? current.map((item, index) => index === existingIndex ? design : item)
              : [...current, design];
            designsByChatRef.current[chatId] = designs;
            const merge = (chat: Chat): Chat => chat.id === chatId ? { ...chat, designs } : chat;
            setChats((previous) => previous.map(merge));
            setPendingChat((previous) => previous ? merge(previous) : previous);
            setActiveChat((previous) => previous ? merge(previous) : previous);
            enterDesignFocus(design.id);
            const ready = await waitForDesignSurfaceReady(15000, { designId: design.id, targetUrl: design.url });
            if (!ready) throw new Error('design_surface_open_timeout');
            data = {
              ok: true, designId: design.id, name: design.name, url: design.url, surface: 'open',
              liveSurfaceReady: true,
            };
          } else {
            data = showDesign(chatId, String(payload?.name || ''));
          }
        } else if (action === 'remove') {
          if (openDesignId && openDesignId === String(payload?.design_id || '')) {
            exitDesignFocus();
          }
          data = { ok: true };
        } else if (action === 'invoke') {
          const surface = designSurfaceRef.current;
          if (!surface?.isReady()) throw new Error('design_surface_unavailable');
          data = await surface.invoke(String(payload?.tool_name || ''), payload?.arguments || {});
        } else if (action === 'screenshot') {
          // dom-ready briefly drops during same-Design reload/navigation. A screenshot
          // request immediately after open should wait for that transition rather than
          // racing it and turning a healthy surface into a spurious failure.
          if (!await waitForDesignSurfaceReady(10000)) throw new Error('design_surface_not_ready');
          const surface = designSurfaceRef.current;
          if (!surface?.isReady()) throw new Error('design_surface_not_ready');
          data = await surface.captureScreenshot();
        } else {
          throw new Error('unknown_design_action');
        }
        await respond({ data });
      } catch (error: any) {
        await respond({ error: error?.message ?? String(error) }).catch(() => {});
      }
    })();
  }), [enterDesignFocus, exitDesignFocus, openDesignId, showDesign]);

  useEffect(() => vulcan.generalWS.onPush('push/design-registry', (payload: any) => {
    const chatId = String(payload?.chat_id || '');
    if (!chatId || !Array.isArray(payload?.designs)) return;
    const designs: DesignAttachment[] = payload.designs.map((item: any) => ({
      ...item,
      attachedAt: new Date(item.attachedAt),
      updatedAt: new Date(item.updatedAt ?? item.attachedAt),
    }));
    designsByChatRef.current[chatId] = designs;
    const updatedAt = new Date(payload.updatedAt ?? Date.now());
    const merge = (chat: Chat): Chat => chat.id === chatId ? { ...chat, designs, updatedAt } : chat;
    setChats((previous) => previous.map(merge));
    setPendingChat((previous) => previous ? merge(previous) : previous);
    setActiveChat((previous) => previous ? merge(previous) : previous);
  }), []);


  // Commit pending chats with a stable placeholder. The server replaces this
  // after the first completed assistant response using the deterministic local
  // title classifier and publishes push/chat-updated.
  const commitPendingChat = async (chat: Chat, _firstUserMessage: string) => {
    const titled = { ...chat, title: chat.title?.trim() || 'New Chat' };
    // Upsert by id — prevents duplicate sidebar entries on rapid double-submit.
    setChats((prev) => {
      const exists = prev.some((c) => c.id === titled.id);
      return exists ? prev.map((c) => c.id === titled.id ? titled : c) : [titled, ...prev];
    });
    pendingChatIdRef.current = null;
    setPendingChat(null);
    setActiveChat(titled);
    persistChatSnapshot(titled, true);
    return titled;
  };

  // Collect tools based on toolMode:
  // - broad: Vulcan built-ins + all enabled kit tools (discovery tools excluded — not needed)
  // - search: Vulcan built-ins + discovery tools only (kit tools excluded — model finds them via search)
  const getAllTools = (chatId: string): Tool[] => {
    const builtins = getVulcanTools(vulcanSettings.cliWorkspaceEnabled, vulcanSettings.toolMode, vulcanSettings.panelsEnabled, chatId, vulcanSettings.libraryEnabled, vulcanSettings.discoveryExecution, isVisionModel(selectedModel));
    if (vulcanSettings.toolMode === 'search') {
      return builtins;
    }
    const discoveryTools = new Set(['list_kits', 'inspect_kit', 'search_tools', 'inspect_tool', 'run_tool']);
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

  // Kept temporarily as a reference implementation for model-visible T2 parity.
  // Active runs use runInference below and never call this client-owned loop.
  const runInferenceLegacy = async (
    currentChat: Chat,
    isPending: boolean,
    eventsAfterUser: ChatEvent[],
    userContent: string,
  ) => {
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const { signal } = abortController;

    let runningEvents = [...eventsAfterUser];
    let committedChat: Chat | null = null;
    const userEvent = eventsAfterUser[eventsAfterUser.length - 1] as UserMessageEvent;
    const runId = userEvent.runId ?? `${currentChat.id}:${userEvent.id}`;

    try {
      const tools = getAllTools(currentChat.id);

      if (isPending) {
        try {
          await vulcan.ensureContainer(currentChat.id);
        } catch { /* container errors are non-fatal */ }
      }

      type OAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
      type OAIMessage = { role: string; content: string | OAIContentPart[] | null; tool_call_id?: string; name?: string; tool_calls?: any[] };

      const buildUserContent = (text: string, event: UserMessageEvent): string | OAIContentPart[] => {
        const images = (event.attachments ?? []).filter((a) => a.dataUrl);
        if (images.length === 0) return text;
        const parts: OAIContentPart[] = [];
        if (text) parts.push({ type: 'text', text });
        for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } });
        return parts;
      };

      // Historical model context is a projection of the same ordered event log the UI
      // renders. There is no separately persisted "message history" to drift from it.
      const projectHistory = (events: ChatEvent[]): OAIMessage[] => {
        const out: OAIMessage[] = [];
        let i = 0;
        while (i < events.length) {
          const event = events[i];
          if (event.type === 'user_message') {
            const quotedText = projectQuotedContent(event.content, event.quotes, event.references, event.contextOrder, event.elements);
            const fullText = event.attachmentNotices
              ? `${quotedText}\n\n${event.attachmentNotices}`.trim()
              : quotedText;
            out.push({ role: 'user', content: buildUserContent(fullText, event) });
            i++;
            continue;
          }
          if (event.type === 'system_message') {
            out.push({ role: 'system', content: event.content });
            i++;
            continue;
          }
          if (!event.turnId) { i++; continue; }

          const turnId = event.turnId;
          const turnEvents: ChatEvent[] = [];
          while (i < events.length && events[i].turnId === turnId) {
            turnEvents.push(events[i]);
            i++;
          }
          const text = turnEvents
            .filter((e): e is AssistantTextEvent => e.type === 'assistant_text')
            .map((e) => e.content)
            .join('');
          const toolEvents = turnEvents.filter((e): e is ToolEvent => e.type === 'tool');
          if (text || toolEvents.length > 0) {
            out.push({
              role: 'assistant',
              content: text || null,
              ...(toolEvents.length > 0 ? {
                tool_calls: toolEvents.map((tool) => tool.rawToolCall ?? {
                  id: tool.callId,
                  type: 'function',
                  function: { name: tool.tool, arguments: tool.rawArguments ?? JSON.stringify(tool.arguments ?? {}) },
                }),
              } : {}),
            });
            for (const tool of toolEvents) {
              if (!tool.result) continue;
              out.push({
                role: 'tool',
                tool_call_id: tool.callId,
                name: tool.tool,
                content: tool.result.error
                  ? JSON.stringify({ error: tool.result.error })
                  : JSON.stringify(tool.result.result ?? tool.result),
              });
            }
          }
        }
        return out;
      };

      const activeSkillSummaries = getActiveBuiltinSkills({
        cliWorkspaceEnabled: vulcanSettings.cliWorkspaceEnabled,
        panelsEnabled: vulcanSettings.panelsEnabled,
        disabledVulcanSkills: vulcanSettings.disabledVulcanSkills,
      }).map(({ name, description }) => ({ name, description }));
      const skillContext = activeSkillSummaries.length
        ? activeSkillSummaries.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
        : '- none';
      const etnaCapabilityIndex = kitsWithTools
        .filter((kit) => enabledKits.includes(kit.kit_name))
        .map((kit) => {
          const names = kit.tools
            .filter((tool) => !disabledTools.has(`${kit.kit_name}::${tool.name}`))
            .map((tool) => tool.name);
          return names.length ? `${kit.kit_name}: ${names.join(', ')}` : '';
        })
        .filter(Boolean)
        .join('\n') || 'none';

      const systemPrompt = vulcanSettings.toolMode === 'search'
        ? `You are Aitna, a technical collaborator who lives in this workspace. You know it the way you know your own tools — the container, the filesystem, the processes running in it are yours to work with, not systems you're being given access to. You think before acting, work incrementally, and talk like a person. When someone says hello, you respond naturally; you don't inventory your capabilities unless asked.

Your workspace is an Ubuntu 24.04 Docker container. Working directory is /workspace — persistent, git-backed, recoverable. Python packages through \`uv pip install\` or \`uv add\`. Full internet access. Networking uses the host network, including host-accessible private VPNs; the terminal skill covers it if you need to go deeper.

Vulcan skills (read directly with read_skill when relevant):
${skillContext}

Etna skills are dynamic. Use list_skills or search_skills to discover standalone and kit-paired Etna skills; their source identifies them as skills or kits/<kit-stem>.

${vulcanSettings.discoveryExecution === 'search-inspect'
  ? 'Etna tools are not listed in advance in this mode. Discover them on demand through capability search.'
  : `${vulcanSettings.discoveryExecution === 'promotion'
    ? 'Etna schemas load on demand. The capability index below names enabled tools but does not make them directly callable. Inspecting an indexed tool loads it for direct use on the next turn.'
    : 'Etna schemas load on demand. The capability index below names enabled tools but does not make them directly callable. Inspect an indexed tool before executing it through run_tool.'}

Enabled Etna capability index (names only; schemas are not loaded):
${etnaCapabilityIndex}`}

Narrate at the level of intent. Say what you're doing and why; don't narrate each tool call. Say what failed and what you're doing about it. Prose over lists.`
        : `You are Aitna, a technical collaborator who lives in this workspace. You know it the way you know your own tools — the container, the filesystem, the processes running in it are yours to work with, not systems you're being given access to. You think before acting, work incrementally, and talk like a person. When someone says hello, you respond naturally; you don't inventory your capabilities unless asked.

Your workspace is an Ubuntu 24.04 Docker container. Working directory is /workspace — persistent, git-backed, recoverable. Python packages through \`uv pip install\` or \`uv add\`. Full internet access. Networking uses the host network, including host-accessible private VPNs; the terminal skill covers it if you need to go deeper.

Vulcan skills (read directly with read_skill when relevant):
${skillContext}

Etna skills are dynamic. Use list_skills or search_skills to discover standalone and kit-paired Etna skills; their source identifies them as skills or kits/<kit-stem>.

Enabled Etna kit tools are already present in your tool list. Use them directly like Vulcan's built-in tools.

Available kits: ${kitsWithTools.filter((k) => enabledKits.includes(k.kit_name)).map((k) => k.kit_name).join(', ')}.

Narrate at the level of intent. Say what you're doing and why; don't narrate each tool call. Say what failed and what you're doing about it. Prose over lists.`;

      let oaiMessages: OAIMessage[] = [
        { role: 'system', content: systemPrompt },
        ...projectHistory(eventsAfterUser.slice(0, -1)),
        { role: 'user', content: buildUserContent(userEvent.quotes?.length || userEvent.references?.length || userEvent.elements?.length
          ? `${projectQuotedContent(userEvent.content, userEvent.quotes, userEvent.references, userEvent.contextOrder, userEvent.elements)}${userEvent.attachmentNotices ? `\n\n${userEvent.attachmentNotices}` : ''}`
          : userContent, userEvent) },
      ];

      let toolCallSeq = 0;
      const repeatCallState = new Map<string, ToolRepeatState>();
      let loopAborted = false;
      let lastRepeatedToolName = '';
      let loopRollbackLength: number | null = null;

      for (let turn = 0; ; turn++) {
        if (signal.aborted) break;
        const turnId = `${runId}:turn:${turn}`;
        const runningLengthBeforeThisTurn = runningEvents.length;
        let streamState = createTurnStreamState(runningEvents);

        const onStreamEvent = (event: LLMStreamEvent) => {
          streamState = applyLLMStreamEvent(streamState, event, { runId, turnId });
          runningEvents = streamState.events;
          updateChatEvents(currentChat.id, runningEvents, committedChat || currentChat, false);
        };


        const { content: assistantContent, thinking: assistantThinking, toolCalls } = await llmClient.chat(
          oaiMessages,
          tools,
          onStreamEvent,
          signal,
        );

        streamState = sealTurnSemantic(streamState, signal.aborted ? 'interrupted' : 'complete');
        runningEvents = streamState.events;
        const streamedToolIds = streamState.toolEventIds;

        // Reconcile streamed tool events with the provider's completed tool_calls. Some
        // providers do not stream tool deltas at all, so append any missing calls now.
        for (let index = 0; index < (toolCalls?.length ?? 0); index++) {
          const tc = toolCalls![index];
          let eventId = streamedToolIds.get(index);
          if (!eventId) {
            eventId = `${turnId}:tool:${index}:${Date.now()}:${toolCallSeq++}`;
            streamedToolIds.set(index, eventId);
            runningEvents = [...runningEvents, {
              id: eventId,
              type: 'tool',
              callId: tc.id || `${turnId}:call:${index}`,
              tool: tc.function?.name ?? '',
              arguments: {},
              rawArguments: tc.function?.arguments ?? '',
              rawToolCall: tc,
              status: 'running',
              timestamp: new Date(),
              runId,
              turnId,
            } as ToolEvent];
          }
          runningEvents = runningEvents.map((event) => {
            if (event.id !== eventId || event.type !== 'tool') return event;
            let args: Record<string, any> = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* malformed args handled by tool */ }
            return {
              ...event,
              callId: tc.id || event.callId,
              tool: tc.function?.name || event.tool,
              arguments: args,
              rawArguments: tc.function?.arguments ?? event.rawArguments,
              rawToolCall: tc,
              status: 'running',
            };
          });
        }

        if (isPending && !committedChat) {
          const chatSnapshot = { ...currentChat, events: runningEvents };
          committedChat = await commitPendingChat(chatSnapshot, userContent);
        } else {
          updateChatEvents(currentChat.id, runningEvents, committedChat || currentChat, true);
        }

        if (signal.aborted || !toolCalls || toolCalls.length === 0) break;

        // Dedicated reasoning is intentionally threaded only inside the still-open
        // tool exchange, matching the previous behavior and avoiding stale CoT buildup.
        oaiMessages.push({
          role: 'assistant',
          content: assistantThinking
            ? `<think>${assistantThinking}</think>${assistantContent || ''}`
            : (assistantContent || null),
          tool_calls: toolCalls,
        });

        const questionCalls = toolCalls
          .filter((tc: any) => tc.function?.name === 'ask_user')
          .map((tc: any) => {
            let parsed: Record<string, any> = {};
            try { parsed = JSON.parse(tc.function.arguments || '{}'); } catch { /* noop */ }
            return {
              toolCallId: tc.id,
              question: String(parsed.question ?? 'Question'),
              options: (Array.isArray(parsed.options) ? parsed.options : []).slice(0, 5).map((value: any) => String(value)),
            };
          });

        for (let index = 0; index < toolCalls.length; index++) {
          const tc = toolCalls[index];
          if (tc.function?.name === 'ask_user') continue;
          if (signal.aborted) break;
          const toolName = tc.function.name;
          let args: Record<string, any> = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* empty args */ }

          const callSignature = `${toolName}::${tc.function.arguments}`;
          // Guard only against tight local loops. If two complete provider turns
          // pass without this exact call, a later revisit starts a fresh streak.
          const repeatCount = noteLocalToolRepeat(repeatCallState, callSignature, turn);
          // Exact-call repetition is only a syntactic signal. Some tools intentionally
          // observe time-varying state with identical arguments, so do not suppress those.
          const repeatGuardEligible = toolName !== 'read_output' && toolName !== 'send_input' && toolName !== 'wait';
          const isRepeatedLoop = repeatGuardEligible && repeatCount > 2;
          if (isRepeatedLoop && loopRollbackLength === null) loopRollbackLength = runningLengthBeforeThisTurn;
          if (repeatGuardEligible && repeatCount > 4) {
            loopAborted = true;
            lastRepeatedToolName = toolName;
          }

          const toolEventId = streamedToolIds.get(index);
          if (!toolEventId) continue;
          runningEvents = runningEvents.map((event) => event.id === toolEventId && event.type === 'tool'
            ? { ...event, status: 'running' }
            : event);
          updateChatEvents(currentChat.id, runningEvents, committedChat || currentChat, true);

          let toolResult: any;
          let syntheticImageMessage: OAIMessage | null = null;
          if (isRepeatedLoop) {
            toolResult = {
              error: `VULCAN_STATE: This exact tool call has been requested repeatedly. Vulcan suppressed this repetition. Reuse the evidence already available or take a different action unless the underlying state is expected to have changed.`,
            };
          } else {
            try {
              if (isVulcanTool(toolName)) {
                const resultStr = await executeVulcanTool(toolName, args, {
                  chatId: currentChat.id,
                  cliWorkspaceEnabled: vulcanSettings.cliWorkspaceEnabled,
                  discoveryExecution: vulcanSettings.discoveryExecution,
                  enabledKits,
                  disabledTools,
                  kitsWithTools,
                  enabledGeneralSkills: skills.filter((skill) => skill.enabled).map(({ name, description, source }) => ({ name, description, source })),
                  panelsEnabled: vulcanSettings.panelsEnabled,
                  disabledVulcanSkills: vulcanSettings.disabledVulcanSkills,
                  getRenderWidth: () => renderWidthRef.current,
                  onPresent: (path) => {
                    const name = path.split('/').pop() ?? path;
                    const pf = { path, name, presentedAt: new Date(), messageId: toolEventId };
                    setPresentedFiles((prev) => [...prev.filter((f) => f.path !== path), pf]);
                    setPresentedFilePath(path);
                    setArtifactsPanelOpen(true);
                    const presentedEvent: ChatEvent = {
                      id: `${toolEventId}:present:${Date.now()}`,
                      type: 'presented_file',
                      file: pf,
                      timestamp: new Date(),
                      runId,
                      turnId,
                    };
                    runningEvents = [...runningEvents, presentedEvent];
                    updateChatEvents(currentChat.id, runningEvents, committedChat || currentChat, true);
                  },
                  designRegister: (name, url) => registerDesign(currentChat.id, name, url),
                  designUpdate: (name, url) => updateDesign(currentChat.id, name, url),
                  designInfo: (name) => designInfo(currentChat.id, name),
                  designList: () => designList(currentChat.id),
                  designRemove: (name) => removeDesign(currentChat.id, name),
                  openDesign: (name) => showDesign(currentChat.id, name),
                  designSurfaceOpen: () => Boolean(openDesignId),
                  designSurfaceAvailable: () => Boolean(designSurfaceRef.current?.isReady()),
                  designSurfaceInvoke: async (name, toolArgs) => {
                    const surface = designSurfaceRef.current;
                    if (!surface?.isReady()) throw new Error('design_surface_unavailable');
                    return surface.invoke(name, toolArgs);
                  },
                  designCaptureScreenshot: async () => {
                    const surface = designSurfaceRef.current;
                    if (!surface?.isReady()) throw new Error('design_surface_unavailable');
                    return surface.captureScreenshot();
                  },
                  onPanel: (name, html, css, js) => {
                    if (html || css || js) savePanel(currentChat.id, name, { html, css, js });
                    const meta: PanelMeta = { name, updatedAt: new Date(), messageId: toolEventId };
                    setPanels((prev) => [...prev.filter((p) => p.name !== name), meta]);
                    setArtifactsPanelOpen(true);
                    const panelEvent: ChatEvent = {
                      id: `${toolEventId}:panel:${Date.now()}`,
                      type: 'panel',
                      panel: meta,
                      timestamp: new Date(),
                      runId,
                      turnId,
                    };
                    runningEvents = [...runningEvents, panelEvent];
                    updateChatEvents(currentChat.id, runningEvents, committedChat || currentChat, true);
                  },
                  onPanelDelete: (name) => setPanels((prev) => prev.filter((p) => p.name !== name)),
                  onTerminalStream: (pid, label) => setAgentRunning(pid, label),
                  onTerminalDone: () => setAgentIdle(),
                  selectedModel,
                  modelVision: isVisionModel(selectedModel),
                  focusedAgentSlot: focusedAgentSlotRef.current,
                  openAgentSlots: openAgentSlotsRef.current,
                  onOpenAgentSlot: handleOpenAgentSlot,
                  onCloseAgentSlot: handleCloseAgentSlot,
                  onSwitchAgentSlot: handleSwitchAgentSlot,
                });
                const parsed = JSON.parse(resultStr);
                if (toolName === 'inspect_tool' && (vulcanSettings.discoveryExecution === 'promotion' || vulcanSettings.discoveryExecution === 'search-inspect') && !parsed.error) {
                  const promotedDesignTool = parsed.kit === 'Design' && designSurfaceRef.current?.isReady()
                    ? getDesignSurfaceTools(isVisionModel(selectedModel)).find((tool) => tool.name === args.tool)
                    : undefined;
                  const promoted = promotedDesignTool ?? kitsWithTools
                    .filter((kit) => enabledKits.includes(kit.kit_name))
                    .flatMap((kit) => kit.tools)
                    .find((tool) => tool.name === args.tool);
                  if (promoted && !tools.some((tool) => tool.name === promoted.name)) tools.push(promoted);
                }
                if (parsed.__view_file_image__) {
                  const imageNotice = parsed.view === 'detail'
                    ? `[System] Detail view of ${parsed.filename}: original image ${parsed.original_width}x${parsed.original_height}; window x=${parsed.region?.x}, y=${parsed.region?.y}, ${parsed.region?.width}x${parsed.region?.height} pixels.`
                    : `[System] Whole-image overview of ${parsed.filename}: original image ${parsed.original_width}x${parsed.original_height}; rendered ${parsed.rendered_width}x${parsed.rendered_height} pixels.`;
                  syntheticImageMessage = {
                    role: 'user',
                    content: [
                      { type: 'text', text: imageNotice },
                      { type: 'image_url', image_url: { url: parsed.dataUrl } },
                    ],
                  };
                  const { dataUrl: _discarded, __view_file_image__: _marker, ...imageMetadata } = parsed;
                  toolResult = { result: imageMetadata };
                } else {
                  toolResult = { result: parsed };
                }
              } else {
                const toolKit = kitsWithTools.find((k) => k.tools.some((t) => t.name === toolName));
                if (
                  !toolKit ||
                  !kits.find((k) => k.kit_name === toolKit.kit_name)?.enabled ||
                  disabledTools.has(`${toolKit.kit_name}::${toolName}`)
                ) {
                  toolResult = { error: `Tool '${toolName}' is not available` };
                } else {
                  const officialEtnaArgs = prepareOfficialEtnaArguments(toolKit.kit_name, toolName, args);
                  const source = (toolKit as any).effective_source;
                  if (!source?.serverId) throw new Error(`Tool '${toolName}' has no resolved Etna source`);
                  toolResult = await runEtnaTool(source, toolName, officialEtnaArgs);
                  if (isOfficialPlaywrightScreenshot(toolKit.kit_name, toolName) && !toolResult.error) {
                    toolResult = await materializeOfficialPlaywrightScreenshot(currentChat.id, tc.id, toolResult, args.save_path);
                  }
                }
              }
            } catch (e) {
              toolResult = { error: String(e) };
            }
          }

          runningEvents = runningEvents.map((event) => event.id === toolEventId && event.type === 'tool'
            ? { ...event, status: toolResult?.error ? 'error' : 'complete', result: toolResult }
            : event);
          updateChatEvents(currentChat.id, runningEvents, committedChat || currentChat, true);

          oaiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: toolName,
            content: toolResult.error
              ? JSON.stringify({ error: toolResult.error })
              : JSON.stringify(toolResult.result ?? toolResult),
          });
          if (syntheticImageMessage) oaiMessages.push(syntheticImageMessage);
          if (loopAborted) break;
        }

        if (loopAborted) {
          if (loopRollbackLength !== null) runningEvents = runningEvents.slice(0, loopRollbackLength);
          const stuckEvent: AssistantTextEvent = {
            id: `${runId}:stuck:${Date.now()}`,
            type: 'assistant_text',
            content: `I got stuck repeatedly trying the same \`${lastRepeatedToolName}\` call and it wasn't going anywhere, so I'm stopping here instead of continuing to loop. Feel free to try again — a fresh attempt sometimes gets past it.`,
            status: 'complete',
            timestamp: new Date(),
            runId,
            turnId: `${runId}:stuck`,
          };
          runningEvents = [...runningEvents, stuckEvent];
          if (isPending && !committedChat) committedChat = await commitPendingChat({ ...currentChat, events: runningEvents }, userContent);
          else updateChatEvents(currentChat.id, runningEvents, committedChat || currentChat, true);
          break;
        }

        if (!signal.aborted && questionCalls.length > 0) {
          const answers = await awaitQuestionBatch({
            id: `${currentChat.id}:${Date.now()}:${turn}`,
            chatId: currentChat.id,
            questions: questionCalls,
          }, signal);

          for (const question of questionCalls) {
            const answer = answers[question.toolCallId] ?? { status: 'skipped' as const };
            const originalTcIndex = toolCalls.findIndex((tc: any) => tc.id === question.toolCallId);
            const toolEventId = streamedToolIds.get(originalTcIndex);
            if (toolEventId) {
              runningEvents = runningEvents.map((event) => event.id === toolEventId && event.type === 'tool'
                ? { ...event, status: 'complete', result: { result: answer } }
                : event);
              updateChatEvents(currentChat.id, runningEvents, committedChat || currentChat, true);
            }
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
      if (error?.name === 'AbortError') return;
      const errEvent: SystemMessageEvent = {
        id: `${runId}:error:${Date.now()}`,
        type: 'system_message',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date(),
        runId,
      };
      const eventsWithError = [...runningEvents, errEvent];
      if (isPending && !committedChat) await commitPendingChat({ ...currentChat, events: eventsWithError }, userContent);
      else updateChatEvents(currentChat.id, eventsWithError, committedChat || currentChat, true);
      toast.error('Inference failed');
    } finally {
      // Any event left in a transient state after Stop/crash becomes interrupted, but
      // its content is retained exactly where it was. This makes interrupted streaming
      // round-trip instead of disappearing on reopen.
      let changed = false;
      const finalized = runningEvents.map((event) => {
        if ((event.type === 'assistant_text' || event.type === 'reasoning' || event.type === 'tool') && (event.status === 'streaming' || event.status === 'running')) {
          changed = true;
          return { ...event, status: 'interrupted' as const, ...(event.type === 'reasoning' ? { completedAt: new Date() } : {}) };
        }
        return event;
      });
      if (changed) updateChatEvents(currentChat.id, finalized, committedChat || currentChat, true);
      setProcessing(false);
      abortControllerRef.current = null;
    }
  };

  const runInference = async (
    currentChat: Chat,
    isPending: boolean,
    eventsAfterUser: ChatEvent[],
    userContent: string,
  ) => {
    try {
      const baseProvider = llmClient.getConfig();
      const selectedProvider = loadProviders().find((item) => item.id === baseProvider.providerId);
      const provider = selectedProvider
        ? { ...selectedProvider, model: baseProvider.model, clientId: selectedProvider.networkPointOfView === 'client' ? getEtnaClientDeviceId() : null }
        : { ...baseProvider, networkPointOfView: 'client' as const, clientId: getEtnaClientDeviceId() };
      const chat = {
        ...currentChat,
        events: eventsAfterUser,
        title: isPending ? 'New Chat' : currentChat.title || 'New Chat',
      };
      if (isPending) {
        // Show the stable placeholder immediately. The server will publish the
        // deterministic title after the first completed assistant response.
        setChats((previous) => previous.some((item) => item.id === chat.id)
          ? previous.map((item) => item.id === chat.id ? chat : item)
          : [chat, ...previous]);
      }
      // Provider dispatch is latency-critical. Use the last good semantic index
      // immediately and repair/rebuild derived embedding state in the background;
      // lexical search remains available if no cache has been warmed yet.
      const toolSemanticIndex = toolSemanticIndexRef.current;
      void repairToolSemanticIndex(kitsWithTools).then((repaired) => {
        if (repaired) toolSemanticIndexRef.current = repaired;
      });
      const response = await vulcan.generalWS.send('runs/start', {
        chat,
        options: {
          userContent,
          autoGenerateTitle: isPending,
          provider,
          settings: vulcanSettings,
          enabledKits,
          disabledTools: Array.from(disabledTools),
          kitsWithTools,
          enabledGeneralSkills: skills.filter((skill) => skill.enabled)
            .map(({ name, description, source }) => ({ name, description, source })),
          etnaSkills: etnaSkillDescriptors,
          toolSemanticIndex,
          renderWidth: renderWidthRef.current,
          modelVision: isVisionModel(selectedModel),
        },
      });
      // r15 deliberately keeps runs/start acknowledgement tiny. The renderer
      // already owns the submitted active-branch transcript; live/final server
      // pushes are authoritative for changes after dispatch.
      if (response?.chat) {
        // Backward compatibility with pre-r15 servers.
        const serverChat = response.chat as Chat;
        const normalizedEvents = rehydrateChatEvents(serverChat.events, false);
        const normalizedBase: Chat = {
          ...serverChat,
          ...(currentChat.branching ? { branching: currentChat.branching } : {}),
          events: normalizedEvents,
          createdAt: new Date(serverChat.createdAt),
          updatedAt: new Date(serverChat.updatedAt),
        };
        const normalized: Chat = currentChat.branching ? syncCurrentBranch(normalizedBase, normalizedEvents) : normalizedBase;
        setChats((previous) => previous.some((item) => item.id === normalized.id)
          ? previous.map((item) => item.id === normalized.id ? normalized : item)
          : [normalized, ...previous]);
        setActiveChat((previous) => previous?.id === normalized.id ? normalized : previous);
      }
      if (isPending) {
        pendingChatIdRef.current = null;
        setPendingChat(null);
      }
    } catch (error: any) {
      setProcessing(false);
      toast.error(`Could not start server-owned agent: ${error?.message ?? String(error)}`);
    }
  };

  // Server push is the sole authority for active transcripts. Never write a pushed
  // snapshot back to the server: doing so can race a newer agent-side checkpoint.
  useEffect(() => {
    const removeEvents = vulcan.generalWS.onPush('push/run-events', (payload: any) => {
      const chatId = String(payload.chat_id ?? '');
      const events = rehydrateChatEvents(payload.events ?? [], false);
      const updatedAt = new Date(payload.updatedAt ?? Date.now());
      const applyEvents = (chat: Chat): Chat => {
        const base = { ...chat, events, updatedAt };
        return chat.branching ? syncCurrentBranch(base, events) : base;
      };
      setChats((previous) => previous.map((chat) => chat.id === chatId ? applyEvents(chat) : chat));
      setPendingChat((previous) => previous?.id === chatId ? applyEvents(previous) : previous);
      setActiveChat((previous) => previous?.id === chatId ? applyEvents(previous) : previous);
    });
    const removeEvent = vulcan.generalWS.onPush('push/run-event', (payload: any) => {
      const chatId = String(payload.chat_id ?? '');
      const event = rehydrateChatEvents(payload.event ? [payload.event] : [], false)[0];
      if (!chatId || !event?.id) return;
      const updatedAt = new Date(payload.updatedAt ?? Date.now());
      const applyEvent = (chat: Chat): Chat => {
        const index = chat.events.findIndex((item) => item.id === event.id);
        const events = index >= 0
          ? chat.events.map((item, itemIndex) => itemIndex === index ? event : item)
          : [...chat.events, event];
        const base = { ...chat, events, updatedAt };
        return chat.branching ? syncCurrentBranch(base, events) : base;
      };
      setChats((previous) => previous.map((chat) => chat.id === chatId ? applyEvent(chat) : chat));
      setPendingChat((previous) => previous?.id === chatId ? applyEvent(previous) : previous);
      setActiveChat((previous) => previous?.id === chatId ? applyEvent(previous) : previous);
    });
    const removeChatUpdate = vulcan.generalWS.onPush('push/chat-updated', (payload: any) => {
      const chatId = String(payload.chat_id ?? '');
      const title = String(payload.title ?? '').trim();
      if (!chatId || !title) return;
      const updatedAt = new Date(payload.updatedAt ?? Date.now());
      setChats((previous) => previous.map((chat) => chat.id === chatId ? { ...chat, title, updatedAt } : chat));
      setActiveChat((previous) => previous?.id === chatId ? { ...previous, title, updatedAt } : previous);
    });
    const removeGenerationComplete = vulcan.generalWS.onPush('push/generation-complete', (payload: any) => {
      const chatId = String(payload.chat_id ?? '');
      if (chatId === activeChatIdRef.current) {
        // OpenAI-compatible providers explicitly tell us when the final model
        // completion ends. Unlock the composer on that signal instead of waiting
        // for server-side persistence/title/checkpoint cleanup.
        setProcessing(false);
      }
    });
    const removeStatus = vulcan.generalWS.onPush('push/run-status', (payload: any) => {
      const chatId = String(payload.chat_id ?? '');
      if (chatId === activeChatIdRef.current) {
        setProcessing(payload.status === 'running' || payload.status === 'waiting_for_user');
      }
      if (payload.status === 'complete') {
        void (window as any).electronAPI?.desktop?.notify?.({
          chatId,
          title: 'Vulcan',
          body: 'Response complete',
        });
      } else if (payload.status === 'error') {
        void (window as any).electronAPI?.desktop?.notify?.({
          chatId,
          title: 'Vulcan',
          body: 'Run failed',
        });
      }
    });
    const removeQuestion = vulcan.generalWS.onPush('push/run-question', (payload: UserQuestionBatch) => {
      if (payload.chatId === activeChatIdRef.current) setQuestionBatch(payload);
    });
    const removePanelDelete = vulcan.generalWS.onPush('push/panel-delete', (payload: any) => {
      if (payload.chat_id !== activeChatIdRef.current) return;
      setPanels((previous) => previous.filter((panel) => panel.name !== payload.name));
      setOpenPanelName((previous) => previous === payload.name ? null : previous);
    });
    const removeTerminal = vulcan.generalWS.onPush('push/terminal-state', (payload: any) => {
      if (payload.chat_id !== activeChatIdRef.current) return;
      openAgentSlotsRef.current = payload.slots ?? [];
      focusedAgentSlotRef.current = payload.focused ?? null;
      setFocusedAgentSlot(payload.focused ?? null);
      void vulcan.listSlots(payload.chat_id).then((slots: any[]) => {
        setTerminalSlots(slots.map((slot: any) => ({
          kind: slot.kind,
          slot: slot.slot,
          chatId: payload.chat_id,
          status: slot.finished
            ? (slot.close_reason === 'inactivity' ? 'closed-inactivity' as const : 'disconnected' as const)
            : 'connected' as const,
        })));
      }).catch(() => {});
    });
    const removeRunning = vulcan.generalWS.onPush('push/terminal-running', (payload: any) => {
      if (payload.chat_id === activeChatIdRef.current) setAgentRunningSlot({ kind: 'agent', slot: payload.slot });
    });
    const removeIdle = vulcan.generalWS.onPush('push/terminal-idle', (payload: any) => {
      if (payload.chat_id === activeChatIdRef.current) setAgentRunningSlot(null);
    });
    const removeReconnect = vulcan.generalWS.onPush('push/connected', () => {
      const chatId = activeChatIdRef.current;
      if (!chatId || pendingChatIdRef.current === chatId) return;
      void vulcan.generalWS.send('runs/subscribe', { chat_id: chatId }).then((result: any) => {
        if (activeChatIdRef.current !== chatId) return;
        setProcessing(result.status === 'running' || result.status === 'waiting_for_user');
        if (result.question) setQuestionBatch(result.question);
        if (result.chat) {
          const events = rehydrateChatEvents(result.chat.events ?? [], false);
          const updatedAt = new Date(result.chat.updatedAt);
          const mergeEvents = (chat: Chat): Chat => {
            const base = { ...chat, events, updatedAt };
            return chat.branching ? syncCurrentBranch(base, events) : base;
          };
          setActiveChat((previous) => previous?.id === chatId ? mergeEvents(previous) : previous);
          setChats((previous) => previous.map((chat) => chat.id === chatId ? mergeEvents(chat) : chat));
        }
      }).catch(() => {});
    });
    return () => {
      removeEvents(); removeEvent(); removeChatUpdate(); removeGenerationComplete(); removeStatus(); removeQuestion(); removePanelDelete(); removeTerminal(); removeRunning(); removeIdle(); removeReconnect();
    };
  }, []);

  // Reconnect or switch chats without attaching run ownership to this renderer.
  useEffect(() => {
    const chatId = activeChat?.id;
    if (!chatId || pendingChatIdRef.current === chatId) return;
    let cancelled = false;
    void vulcan.generalWS.send('runs/subscribe', { chat_id: chatId }).then((result: any) => {
      if (cancelled || activeChatIdRef.current !== chatId) return;
      setProcessing(result.status === 'running' || result.status === 'waiting_for_user');
      if (result.question) setQuestionBatch(result.question);
      if (result.chat) {
        const restoredEvents = rehydrateChatEvents(result.chat.events ?? [], false);
        setActiveChat((previous) => {
          if (previous?.id !== chatId) return previous;
          const base = { ...result.chat, ...(previous.branching ? { branching: previous.branching } : {}), events: restoredEvents, createdAt: new Date(result.chat.createdAt), updatedAt: new Date(result.chat.updatedAt) } as Chat;
          return previous.branching ? syncCurrentBranch(base, restoredEvents) : base;
        });
        setChats((previous) => previous.map((item) => {
          if (item.id !== chatId) return item;
          const base = { ...result.chat, ...(item.branching ? { branching: item.branching } : {}), events: restoredEvents, createdAt: new Date(result.chat.createdAt), updatedAt: new Date(result.chat.updatedAt) } as Chat;
          return item.branching ? syncCurrentBranch(base, restoredEvents) : base;
        }));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeChat?.id, connected]);

  const handleSendMessage = async (content: string, files?: File[], quotes?: MessageQuote[], references?: MessageFileReference[], contextOrder?: string[], elements?: MessageElementReference[]) => {
    if (!activeChat || processing) return;

    let currentChat = activeChat;
    const isPending = pendingChat?.id === currentChat.id;

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

    if (processedAttachments.length > 0) setAttachments((prev) => [...prev, ...processedAttachments]);

    const attachmentNotices = vulcanSettings.cliWorkspaceEnabled && processedAttachments.length > 0
      ? processedAttachments.map((a) => {
          const path = `/attachments/${a.name}`;
          if (a.type.startsWith('image/')) {
            return `User attached image: ${a.name}\nLocation: ${path}\nThe image is also included inline above — use the path if you need to process it with code.`;
          }
          return `User attached: ${a.name}\nLocation: ${path}\nUse the terminal to interact with it.`;
        }).join('\n\n')
      : null;

    const eventId = Date.now().toString();
    const runId = `${currentChat.id}:${eventId}`;
    const userEvent: UserMessageEvent = {
      id: eventId,
      type: 'user_message',
      content,
      ...(quotes?.length ? { quotes } : {}),
      ...(references?.length ? { references } : {}),
      ...(elements?.length ? { elements } : {}),
      ...(contextOrder?.length ? { contextOrder } : {}),
      attachments: processedAttachments.length > 0 ? processedAttachments : undefined,
      ...(attachmentNotices ? { attachmentNotices } : {}),
      timestamp: new Date(),
      runId,
    };

    let eventsAfterUser: ChatEvent[];
    if (branchMode && selectedBranch && activeBranching && selectedBranch.id !== activeBranching.currentBranchId) {
      const branched = createBranch(currentChat, 'jump', selectedBranch.id, [...selectedBranchEvents, userEvent]);
      currentChat = branched.chat;
      eventsAfterUser = branched.chat.events;
      setSelectedBranchId(branched.branch.id);
      setActiveChat(branched.chat);
      setChats((previous) => previous.map((chat) => chat.id === branched.chat.id ? branched.chat : chat));
      // The imminent runs/start persists the branch snapshot server-side.
    } else {
      eventsAfterUser = [...currentChat.events, userEvent];
    }
    // runs/start carries this exact active transcript and owns initial durable
    // persistence. Avoid a duplicate multi-megabyte chats/upsert in front of it.
    updateChatEvents(currentChat.id, eventsAfterUser, currentChat, false, false);
    setProcessing(true);

    if (!llmClient.isConfigured()) {
      const echo: AssistantTextEvent = {
        id: `${runId}:unconfigured`,
        type: 'assistant_text',
        content: 'LLM not configured. Go to Settings → Providers to add an endpoint and API key.',
        status: 'complete',
        timestamp: new Date(),
        runId,
        turnId: `${runId}:turn:0`,
      };
      const finalEvents = [...eventsAfterUser, echo];
      updateChatEvents(currentChat.id, finalEvents, currentChat, true);
      setProcessing(false);
      if (isPending) await commitPendingChat({ ...currentChat, events: finalEvents }, content);
      return;
    }

    const fullContent = attachmentNotices ? `${content}\n\n${attachmentNotices}`.trim() : content;
    runInference(currentChat, isPending, eventsAfterUser, fullContent);
  };

  // ── Edit + retry ────────────────────────────────────────────────────────────

  const handleEditMessage = async (eventId: string, payload: MessageEditPayload) => {
    if (!activeChat || processing) return;
    const state = ensureBranching(activeChat);
    const parentBranchId = branchMode && effectiveSelectedBranchId ? effectiveSelectedBranchId : state.currentBranchId;
    const baseEvents = branchMode && selectedBranch ? selectedBranchEvents : activeChat.events;
    const idx = baseEvents.findIndex((event) => event.id === eventId && event.type === 'user_message');
    if (idx === -1) return;
    const original = baseEvents[idx] as UserMessageEvent;

    const newAttachments = await Promise.all(
      (payload.newFiles ?? []).map(async (file) => {
        let dataUrl: string | undefined;
        if (file.type.startsWith('image/')) {
          dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          });
        }
        return { name: file.name, size: file.size, type: file.type, dataUrl };
      })
    );
    const finalAttachments = mergeEditedAttachments(payload.attachments, newAttachments);
    if (newAttachments.length > 0) setAttachments((previous) => [...previous, ...newAttachments]);
    const attachmentNotices = vulcanSettings.cliWorkspaceEnabled && finalAttachments.length > 0
      ? finalAttachments.map((attachment) => {
          const path = `/attachments/${attachment.name}`;
          return attachment.type.startsWith('image/')
            ? `User attached image: ${attachment.name}
Location: ${path}
The image is also included inline above — use the path if you need to process it with code.`
            : `User attached: ${attachment.name}
Location: ${path}
Use the terminal to interact with it.`;
        }).join('\n\n')
      : undefined;

    const editedEvent: UserMessageEvent = {
      ...original,
      id: `${original.id}:edit:${Date.now()}`,
      content: payload.content,
      attachments: finalAttachments.length > 0 ? finalAttachments : undefined,
      quotes: payload.quotes?.length ? payload.quotes : undefined,
      references: payload.references?.length ? payload.references : undefined,
      elements: payload.elements?.length ? payload.elements : undefined,
      contextOrder: payload.contextOrder?.length ? payload.contextOrder : undefined,
      attachmentNotices,
      timestamp: new Date(),
      runId: `${activeChat.id}:${original.id}:retry:${Date.now()}`,
    };
    const truncated = [...baseEvents.slice(0, idx), editedEvent];
    const branched = createBranch(activeChat, 'edit', parentBranchId, truncated);
    const updatedChat = branched.chat;
    setSelectedBranchId(branched.branch.id);
    const isPending = pendingChat?.id === activeChat.id;

    if (isPending) setPendingChat(updatedChat);
    else {
      setChats((prev) => prev.map((chat) => chat.id === updatedChat.id ? updatedChat : chat));
      // runs/start persists this branch snapshot without an extra preflight upload.
    }
    setActiveChat(updatedChat);
    setProcessing(true);
    const projected = projectQuotedContent(editedEvent.content, editedEvent.quotes, editedEvent.references, editedEvent.contextOrder, editedEvent.elements);
    const modelContent = editedEvent.attachmentNotices
      ? `${projected}

${editedEvent.attachmentNotices}`.trim()
      : projected;
    runInference(updatedChat, isPending, truncated, modelContent);
  };


  const handleRetry = (userEventId: string) => {
    if (!activeChat || processing) return;
    const state = ensureBranching(activeChat);
    const parentBranchId = branchMode && effectiveSelectedBranchId ? effectiveSelectedBranchId : state.currentBranchId;
    const baseEvents = branchMode && selectedBranch ? selectedBranchEvents : activeChat.events;
    const idx = baseEvents.findIndex((event) => event.id === userEventId && event.type === 'user_message');
    if (idx === -1) return;
    const original = baseEvents[idx] as UserMessageEvent;
    const retriedUser: UserMessageEvent = { ...original, id: `${original.id}:regen:${Date.now()}`, timestamp: new Date(), runId: `${activeChat.id}:${original.id}:retry:${Date.now()}` };
    const truncated = [...baseEvents.slice(0, idx), retriedUser];
    const branched = createBranch(activeChat, 'regen', parentBranchId, truncated);
    const updatedChat = branched.chat;
    setSelectedBranchId(branched.branch.id);
    const isPending = pendingChat?.id === activeChat.id;

    if (isPending) setPendingChat(updatedChat);
    else {
      setChats((prev) => prev.map((c) => c.id === updatedChat.id ? updatedChat : c));
      // runs/start persists this branch snapshot without an extra preflight upload.
    }
    setActiveChat(updatedChat);
    setProcessing(true);
    const modelContent = retriedUser.attachmentNotices
      ? `${retriedUser.content}\n\n${retriedUser.attachmentNotices}`.trim()
      : retriedUser.content;
    runInference(updatedChat, isPending, truncated, modelContent);
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
      const schema = tool.parameters.properties?.[param];
      if (schema?.type === 'string') template[param] = '';
      else if (schema?.type === 'integer' || schema?.type === 'number') template[param] = 0;
      else if (schema?.type === 'boolean') template[param] = false;
      else template[param] = null;
    });

    const infoEvent: SystemMessageEvent = {
      id: Date.now().toString(),
      type: 'system_message',
      content: `Tool: **${toolName}**\n\nRequired: ${tool.parameters.required?.join(', ') || 'none'}\n\nTemplate:\n\`\`\`json\n${JSON.stringify(template, null, 2)}\n\`\`\``,
      timestamp: new Date(),
    };
    updateChatEvents(activeChat.id, [...activeChat.events, infoEvent], activeChat, true);
    toast.info(`Added template for ${toolName}`);
  };

  const closeDesign = useCallback(() => {
    exitDesignFocus();
  }, [exitDesignFocus]);

  const attachDesignElement = useCallback((element: MessageElementReference) => {
    if (!activeChat) return;
    window.dispatchEvent(new CustomEvent('vulcan:element-reference', {
      detail: { ...element, chatId: activeChat.id },
    }));
    toast.success('Element attached to your next message');
  }, [activeChat?.id]);

  // The active chat to render — could be pending or committed
  const displayChat = activeChat;
  const openDesign = displayChat?.designs?.find((item) => item.id === openDesignId) ?? null;
  const displayEvents = branchMode && selectedBranch ? selectedBranchEvents : (displayChat?.events || []);
  return (
    <div className="dark h-screen flex flex-col bg-ash-950 text-ash-100">
      <Toaster position="top-right" theme="dark" offset={{ top: 64 }} />
      <HarnessTrustDialog />
      <ServerPasswordDialog />
      <UpdatePrompt />
      <TopBar
        connected={connected}
        vulcanConnected={vulcanConnected}
        providerConnectionState={providerConnectionState}
        etnaServers={etnaServers}
        etnaLogicalKits={etnaLogicalKits}
        etnaSummary={etnaSummary}
        onEtnaStateChange={applyEtnaState}
        activeVulcanEndpoint={activeVulcanEndpoint}
        isSwitchingVulcanServer={isSwitchingVulcanServer}
        kits={kits.map((k) => ({ ...k, enabled: enabledKits.includes(k.kit_name) }))}
        vulcanSettings={vulcanSettings}
        onVulcanSettingsChange={handleVulcanSettingsChange}
        kitsWithTools={kitsWithTools}
        llmConfig={llmConfig}
        selectedModel={selectedModel}
        chatTitle={displayChat?.title}
        branchMode={branchMode}
        canToggleBranchMode={Boolean(displayChat?.events.length)}
        disabledTools={disabledTools}
        sidebarCollapsed={sidebarCollapsed}
        sidebarSizePercent={sidebarSizePercent}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onSwitchVulcanServer={handleSwitchVulcanServer}
        onLLMConfigChange={handleLLMConfigChange}
        onSelectModel={handleSelectModel}
        onToggleBranchMode={toggleBranchMode}
        artifactsPanelOpen={artifactsPanelOpen}
        onToggleArtifacts={() => setArtifactsPanelOpen((v) => !v)}
        onTestInferenceConnection={testInferenceConnection}
        onRefresh={handleRefresh}
        onToggleDisabledTool={toggleDisabledTool}
        onEnableAllToolsInKit={enableAllToolsInKit}
        onToggleKit={handleToggleKit}
        skills={allSkills}
        onToggleSkill={handleToggleSkill}
      />

      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="horizontal" id="main-layout">
          {!sidebarCollapsed && !designOpen && (
            <>
              <Panel id="left-sidebar" order={1} defaultSize={20} minSize={15} maxSize={30} onResize={setSidebarSizePercent}>
                <div className="h-full min-h-0 flex flex-col bg-ash-900 border-r border-ash-800">
                  <div className="flex-1 min-h-0">
                    <KitSidebar
                      chats={chats}
                      folders={chatFolders}
                      activeChat={displayChat}
                      onSelectChat={handleSelectChat}
                      onNewChat={handleNewChat}
                      onNewFolder={handleNewFolder}
                      onDeleteChat={handleDeleteChat}
                      onDownloadChat={handleDownloadChat}
                      onRenameChat={handleRenameChat}
                      onRenameFolder={handleRenameFolder}
                      onDeleteFolder={handleDeleteFolder}
                      onSetFolderCollapsed={handleSetFolderCollapsed}
                      onMoveItem={handleMoveSidebarItem}
                      embedded
                      terminalChatStatuses={terminalChatStatuses}
                      emptyText={chatIndexHydrated ? 'No chats yet' : 'Loading chats…'}
                      searchQuery={universalSearchQuery}
                      onSearchQueryChange={setUniversalSearchQuery}
                      searchInputRef={universalSearchInputRef}
                      searchMatchesByChat={searchMatchesByChat}
                      searchHitIndexByChat={searchHitIndexByChat}
                      onNavigateSearchHit={navigateSearchHit}
                      onSelectSearchHit={selectSearchHit}
                      onSearchInputKeyDown={handleUniversalSearchKeyDown}
                      branchMode={branchMode}
                      branches={activeBranches}
                      selectedBranchId={effectiveSelectedBranchId}
                      branchSearchMatches={branchSearchMatches}
                      branchSearchHitIndex={branchSearchHitIndexById}
                      onSelectBranch={selectBranch}
                      onRenameBranch={handleRenameBranch}
                      onNavigateBranchSearchHit={navigateBranchSearchHit}
                      onSelectBranchSearchHit={selectBranchSearchHit}
                    />
                  </div>
                </div>
              </Panel>
              <PanelResizeHandle id="left-handle" className="w-1 bg-ash-800 hover:bg-coral-500 transition-colors cursor-col-resize" />
            </>
          )}

          <Panel id="chat-main" order={2} minSize={30}>
            {branchMode && displayChat && activeBranching && selectedBranch ? (
              <PanelGroup direction="horizontal" id="branch-layout">
                <Panel id="branch-graph" order={1} defaultSize={56} minSize={32}>
                  <BranchGraph
                    branches={activeBranches}
                    selectedBranchId={selectedBranch.id}
                    currentBranchId={activeBranching.currentBranchId}
                    onSelectBranch={selectBranch}
                    onRenameBranch={handleRenameBranch}
                  />
                </Panel>
                <PanelResizeHandle id="branch-handle" className="w-1 bg-ash-800 hover:bg-coral-500 transition-colors cursor-col-resize" />
                <Panel id="branch-preview" order={2} defaultSize={44} minSize={30}>
                  <ChatInterface
                    chatId={displayChat.id}
                    transcriptViewId={`${displayChat.id}:branch:${selectedBranch.id}`}
                    events={displayEvents}
                    kits={kits.map((k) => ({ ...k, enabled: enabledKits.includes(k.kit_name) }))}
                    onSendMessage={handleSendMessage}
                    onToggleKit={handleToggleKit}
                    skills={allSkills}
                    onToggleSkill={handleToggleSkill}
                    onStop={handleStop}
                    onEditMessage={handleEditMessage}
                    onRetry={handleRetry}
                    isProcessing={processing}
                    uploadsEnabled={vulcanSettings.cliWorkspaceEnabled}
                    questionBatch={questionBatch && questionBatch.chatId === displayChat.id ? questionBatch : null}
                    onResolveQuestionBatch={resolveQuestionBatch}
                    searchQuery={universalSearchQuery}
                    activeSearchMatch={hydratedSelectedBranchSearchMatches[branchSearchHitIndex(selectedBranch.id)]}
                  />
                </Panel>
              </PanelGroup>
            ) : openDesign ? (
              <PanelGroup direction="horizontal" id={`live-pane-layout-${displayChat.id}`}>
                <Panel id="live-pane-chat" order={1} defaultSize={30} minSize={22}>
                  <ChatInterface
                    chatId={displayChat.id}
                    transcriptViewId={`${displayChat.id}:main`}
                    events={displayEvents}
                    kits={kits.map((k) => ({ ...k, enabled: enabledKits.includes(k.kit_name) }))}
                    onSendMessage={handleSendMessage}
                    onToggleKit={handleToggleKit}
                    skills={allSkills}
                    onToggleSkill={handleToggleSkill}
                    onStop={handleStop}
                    onEditMessage={handleEditMessage}
                    onRetry={handleRetry}
                    isProcessing={processing}
                    uploadsEnabled={vulcanSettings.cliWorkspaceEnabled}
                    questionBatch={questionBatch && questionBatch.chatId === displayChat.id ? questionBatch : null}
                    onResolveQuestionBatch={resolveQuestionBatch}
                    searchQuery={universalSearchQuery}
                    activeSearchMatch={hydratedActiveChatSearchMatches[searchHitIndex(displayChat.id)]}
                  />
                </Panel>
                <PanelResizeHandle
                  id="live-pane-handle"
                  className={designOpen ? 'w-1 bg-ash-800 hover:bg-blue-500 transition-colors cursor-col-resize' : 'w-0 overflow-hidden'}
                />
                <Panel
                  ref={designPanelRef}
                  id="live-pane-stage"
                  order={2}
                  defaultSize={70}
                  minSize={42}
                  collapsible
                  collapsedSize={0}
                  onCollapse={exitDesignFocus}
                  onExpand={() => setDesignOpen(true)}
                >
                  <DesignSurface
                    ref={designSurfaceRef}
                    design={openDesign}
                    chatId={displayChat.id}
                    onClose={closeDesign}
                    onElement={attachDesignElement}
                  />
                </Panel>
              </PanelGroup>
            ) : (
              <ChatInterface
                chatId={displayChat?.id}
                transcriptViewId={displayChat ? `${displayChat.id}:main` : '__new__'}
                events={displayEvents}
                kits={kits.map((k) => ({ ...k, enabled: enabledKits.includes(k.kit_name) }))}
                onSendMessage={handleSendMessage}
                onToggleKit={handleToggleKit}
                skills={allSkills}
                onToggleSkill={handleToggleSkill}
                onStop={handleStop}
                onEditMessage={handleEditMessage}
                onRetry={handleRetry}
                isProcessing={processing}
                uploadsEnabled={vulcanSettings.cliWorkspaceEnabled}
                questionBatch={questionBatch && questionBatch.chatId === displayChat?.id ? questionBatch : null}
                onResolveQuestionBatch={resolveQuestionBatch}
                searchQuery={universalSearchQuery}
                activeSearchMatch={displayChat ? hydratedActiveChatSearchMatches[searchHitIndex(displayChat.id)] : undefined}
              />
            )}
          </Panel>

          {artifactsPanelOpen && !designOpen && (
            <>
              <PanelResizeHandle id="right-handle" className="w-1 bg-ash-800 hover:bg-coral-500 transition-colors cursor-col-resize" />
              <Panel id="right-workspace" order={3} defaultSize={30} minSize={20} maxSize={50}>
                <WorkspacePanel
                  chatId={workspaceChatId}
                  presentedFiles={presentedFiles}
                  panels={panels}
                  designs={displayChat?.designs ?? []}
                  openDesignId={openDesignId}
                  onOpenDesign={(name) => displayChat && showDesign(displayChat.id, name)}
                  attachments={attachments}
                  openFilePath={presentedFilePath}
                  openPanelName={openPanelName}
                  onFileOpened={() => setPresentedFilePath(null)}
                  onPanelOpened={() => setOpenPanelName(null)}
                  cliWorkspaceEnabled={vulcanSettings.cliWorkspaceEnabled}
                  terminalSlots={terminalSlots}
                  activeTerminalSlot={activeTerminalSlot}
                  agentRunningSlot={agentRunningSlot}
                  onSelectTerminalSlot={handleSelectTerminalSlot}
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
