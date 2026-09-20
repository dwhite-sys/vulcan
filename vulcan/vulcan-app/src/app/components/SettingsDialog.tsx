import { useEffect, useRef, useState } from 'react';
import { X, RefreshCw, Eye, EyeOff, ChevronDown, ChevronRight, ShieldCheck, Trash2, Clipboard, ClipboardCheck, AlertTriangle } from 'lucide-react';
import type { Kit, KitWithTools, LogicalEtnaKit, EtnaServerProfile, EtnaSummary } from '../types/vulcan';
import type { SkillMeta } from './SkillToggleMenu';
import { listModelsForProvider, testProviderConnection, type LLMConfig, type ProviderConfig } from '../services/llm';
import { loadProviders, saveProviders, type VulcanSettings } from '../services/persistence';
import { loadVulcanServerProfiles, newVulcanServerProfileId, normalizeVulcanServerUrl, saveVulcanServerProfiles, type VulcanServerProfile } from '../services/serverProfiles';
import { SkillPackageExplorer } from './SkillPackageExplorer';
import { KitContentsExplorer } from './KitContentsExplorer';
import { formatSkillDisplayName, listSkillPackageFiles } from '../services/skillPackageFiles';
import { libraryStatus, uploadLibraryFile } from '../services/vulcan';
import { generalWS } from '../services/ws';
import { saveEtnaServers, refreshEtnaState, setEtnaRoute, clientDeviceId } from '../services/etnaRegistry';
import { forgetTrustedHarness, listTrustedHarnesses, type TrustedHarness } from '../services/harnessTrust';



function NetworkPointOfViewToggle({
  value,
  onChange,
}: {
  value: 'client' | 'server';
  onChange: (value: 'client' | 'server') => void;
}) {
  const nextValue = value === 'client' ? 'server' : 'client';

  return (
    <button
      type="button"
      title="Change from which point of view the networking works"
      aria-label={`Networking point of view: ${value}. Click to switch to ${nextValue}.`}
      onClick={() => onChange(nextValue)}
      className="inline-flex flex-shrink-0 rounded-full border border-ash-700/70 bg-ash-900/80 p-0.5 shadow-sm"
    >
      {(['client', 'server'] as const).map((variant) => (
        <span
          key={variant}
          className={`rounded-full px-2 py-0.5 text-[9px] font-semibold tracking-wide transition-colors ${
            value === variant
              ? 'bg-coral-500 text-white'
              : 'text-ash-500'
          }`}
        >
          {variant === 'client' ? 'Client' : 'Server'}
        </span>
      ))}
    </button>
  );
}

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  kits: Kit[];
  kitsWithTools: KitWithTools[];
  etnaServers: EtnaServerProfile[];
  etnaLogicalKits: LogicalEtnaKit[];
  etnaSummary: EtnaSummary;
  onEtnaStateChange: (state: any) => void;
  activeVulcanEndpoint: string;
  isSwitchingVulcanServer: boolean;
  llmConfig: LLMConfig;
  vulcanSettings: VulcanSettings;
  disabledTools: Set<string>;
  onSwitchVulcanServer: (profile: VulcanServerProfile) => Promise<void>;
  onLLMConfigChange: (config: Partial<LLMConfig>) => void;
  onVulcanSettingsChange: (settings: Partial<VulcanSettings>) => void;
  onRefresh: () => void;
  onTestInferenceConnection: () => Promise<boolean>;
  onToggleDisabledTool: (toolKey: string) => void;
  onEnableAllToolsInKit: (kitName: string) => void;
  onToggleKit: (kitName: string, enabled: boolean) => void;
  skills: SkillMeta[];
  onToggleSkill: (stem: string, enabled: boolean) => void;
}

export function SettingsDialog({
  isOpen,
  onClose,
  kits,
  kitsWithTools,
  etnaServers,
  etnaLogicalKits,
  etnaSummary,
  onEtnaStateChange,
  activeVulcanEndpoint,
  isSwitchingVulcanServer,
  llmConfig,
  vulcanSettings,
  disabledTools,
  onSwitchVulcanServer,
  onLLMConfigChange,
  onVulcanSettingsChange,
  onRefresh,
  onTestInferenceConnection,
  onToggleDisabledTool,
  onEnableAllToolsInKit,
  onToggleKit,
  skills,
  onToggleSkill,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<'server' | 'llm' | 'vulcan' | 'security' | 'kits' | 'skills'>('server');
  const [activeSkillCategory, setActiveSkillCategory] = useState<'vulcan' | 'etna'>('vulcan');
  const [editingEtnaServerId, setEditingEtnaServerId] = useState<string | null>(null);
  const [etnaServerName, setEtnaServerName] = useState('');
  const [etnaUrlInput, setEtnaUrlInput] = useState('http://localhost:8467');
  const [etnaNetworkPointOfView, setEtnaNetworkPointOfView] = useState<'client' | 'server'>('client');
  const [etnaEditorStatus, setEtnaEditorStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [etnaSaveError, setEtnaSaveError] = useState('');
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviders());
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerName, setProviderName] = useState('');
  const [llmUrl, setLlmUrl] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [providerNetworkPointOfView, setProviderNetworkPointOfView] = useState<'client' | 'server'>('client');
  const [providerStatuses, setProviderStatuses] = useState<Record<string, boolean>>({});
  const [discoveredModels, setDiscoveredModels] = useState<Array<{ id: string; providerId: string }>>([]);
  const [showKey, setShowKey] = useState(false);
  const [inferenceTestStatus, setInferenceTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [providerSaveStatus, setProviderSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [providerSaveError, setProviderSaveError] = useState('');
  const [trustedHarnesses, setTrustedHarnesses] = useState<TrustedHarness[]>([]);
  const [copiedHarnessPinKey, setCopiedHarnessPinKey] = useState<string | null>(null);
  const [libraryInfo, setLibraryInfo] = useState<{ path: string; count: number } | null>(null);
  const [libraryUploadError, setLibraryUploadError] = useState('');
  const [libraryUploading, setLibraryUploading] = useState(false);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { kind: 'provider'; provider: ProviderConfig }
    | { kind: 'etna'; server: EtnaServerProfile }
    | { kind: 'server'; server: VulcanServerProfile }
    | { kind: 'harness'; harness: TrustedHarness }
    | null
  >(null);
  const [vulcanServers, setVulcanServers] = useState<VulcanServerProfile[]>(() => loadVulcanServerProfiles());
  const [editingVulcanServerId, setEditingVulcanServerId] = useState<string | null>(null);
  const [vulcanServerName, setVulcanServerName] = useState('');
  const [vulcanEndpointInput, setVulcanEndpointInput] = useState('');
  const [vulcanServerStatuses, setVulcanServerStatuses] = useState<Record<string, boolean>>({});
  const [vulcanServerSaveStatus, setVulcanServerSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [vulcanServerSaveError, setVulcanServerSaveError] = useState('');
  const [vulcanEndpointTestStatus, setVulcanEndpointTestStatus] = useState<'idle'|'testing'|'ok'|'fail'>('idle');
  const [expandedSkillPackages, setExpandedSkillPackages] = useState<Set<string>>(() => new Set());
  const [kitSkillNames, setKitSkillNames] = useState<Record<string, string>>({});
  const [skillFileCounts, setSkillFileCounts] = useState<Record<string, number>>({});
  const skillFileCountKey = JSON.stringify(
    skills.map((skill) => [skill.stem, skill.name, skill.source]),
  );
  // Each open/close transition starts a new settings-session generation. Async
  // connection checks capture the current generation so an in-flight request
  // cannot resurrect a stale "Connected" state after Settings has closed.
  const settingsSessionRef = useRef(0);

  useEffect(() => {
    settingsSessionRef.current += 1;
    if (isOpen) {
      setVulcanServers(loadVulcanServerProfiles());
      setProviders(loadProviders());
      setActiveSkillCategory('vulcan');
    } else {
      setInferenceTestStatus('idle');
      setVulcanEndpointTestStatus('idle');
      setVulcanServerStatuses({});
      setProviderStatuses({});
      setDiscoveredModels([]);
    }
  }, [isOpen]);

  useEffect(() => {
    const refreshProvidersFromServer = () => setProviders(loadProviders());
    window.addEventListener('vulcan:providers-changed', refreshProvidersFromServer);
    return () => window.removeEventListener('vulcan:providers-changed', refreshProvidersFromServer);
  }, []);

  const etnaClientDeviceId = clientDeviceId;

  const newEtnaServer = () => {
    setEditingEtnaServerId(null);
    setEtnaServerName('');
    setEtnaUrlInput('http://localhost:8467');
    setEtnaNetworkPointOfView('client');
    setEtnaEditorStatus('idle');
    setEtnaSaveError('');
  };

  const editEtnaServer = (server: EtnaServerProfile) => {
    setEditingEtnaServerId(server.id);
    setEtnaServerName(server.name);
    setEtnaUrlInput(server.url);
    setEtnaNetworkPointOfView(server.networkPointOfView);
    setEtnaEditorStatus(server.healthy ? 'ok' : 'fail');
    setEtnaSaveError('');
  };

  const saveEtnaServer = async () => {
    const name = etnaServerName.trim();
    const url = etnaUrlInput.trim().replace(/\/$/, '');
    if (!name || !url) { setEtnaSaveError('Server name and URL are required.'); return; }
    const id = editingEtnaServerId ?? crypto.randomUUID();
    const next: EtnaServerProfile = {
      id, name, url, networkPointOfView: etnaNetworkPointOfView,
      clientId: etnaNetworkPointOfView === 'client' ? etnaClientDeviceId() : null,
      enabled: true, healthy: etnaServers.find((item) => item.id === id)?.healthy ?? false,
    };
    const merged = editingEtnaServerId
      ? etnaServers.map((item) => item.id === id ? { ...item, ...next } : item)
      : [...etnaServers, next];
    try {
      await vulcanClientSaveEtna(merged);
      setEditingEtnaServerId(id);
      setEtnaSaveError('');
    } catch (error: any) { setEtnaSaveError(error?.message ?? String(error)); }
  };

  const vulcanClientSaveEtna = async (servers: EtnaServerProfile[]) => {
    saveEtnaServers(servers.map((server) => ({ ...server, clientId: null })));
    const refreshed = await refreshEtnaState();
    onEtnaStateChange(refreshed);
    return refreshed;
  };

  const deleteEtnaServer = async (server: EtnaServerProfile) => {
    await vulcanClientSaveEtna(etnaServers.filter((item) => item.id !== server.id));
    if (editingEtnaServerId === server.id) newEtnaServer();
  };

  const toggleEtnaServerEnabled = async (server: EtnaServerProfile) => {
    await vulcanClientSaveEtna(etnaServers.map((item) => item.id === server.id ? { ...item, enabled: !item.enabled } : item));
  };

  const setEtnaRouteChoice = async (logicalId: string, serverId: string | null) => {
    const state = await setEtnaRoute(logicalId, serverId);
    onEtnaStateChange(state);
  };

  const refreshTrustedHarnesses = () => { void listTrustedHarnesses().then(setTrustedHarnesses); };

  const copyHarnessFingerprint = async (pinKey: string, fingerprint: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fingerprint);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = fingerprint;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedHarnessPinKey(pinKey);
      window.setTimeout(() => {
        setCopiedHarnessPinKey((current) => current === pinKey ? null : current);
      }, 1000);
    } catch (error) {
      console.error('Failed to copy trusted harness fingerprint:', error);
    }
  };
  useEffect(() => { if (isOpen && activeTab === 'security') refreshTrustedHarnesses(); }, [isOpen, activeTab]);
  // The provider editor continuously observes the candidate endpoint while
  // Settings is open. This is display-only state: saving remains an explicit
  // action, and the provider registry polling below remains unchanged.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const session = settingsSessionRef.current;
    // Reset only when the edited provider candidate changes. Background polls
    // preserve the last confirmed state until a new result is available.
    setInferenceTestStatus('testing');

    const poll = async () => {
      const baseUrl = llmUrl.trim();
      if (!baseUrl) {
        if (!cancelled && settingsSessionRef.current === session) setInferenceTestStatus('fail');
        return;
      }

      const temp: ProviderConfig = {
        id: editingProviderId ?? 'candidate',
        name: providerName || 'Candidate',
        baseUrl,
        apiKey: llmKey,
        networkPointOfView: providerNetworkPointOfView,
      };

      try {
        const ok = await testProviderConnection(temp);
        if (!cancelled && settingsSessionRef.current === session) {
          setInferenceTestStatus(ok ? 'ok' : 'fail');
        }
      } catch {
        if (!cancelled && settingsSessionRef.current === session) {
          setInferenceTestStatus('fail');
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOpen, editingProviderId, providerName, llmUrl, llmKey]);

  // Every saved server has its own passive reachability indicator. The editor
  // candidate remains independent, and probing never changes the active server.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const session = settingsSessionRef.current;
    const poll = async () => {
      const results = await Promise.all(vulcanServers.map(async (server) => {
        try {
          const response = await fetch(`${server.url}/ping`);
          return [server.id, response.ok] as const;
        } catch {
          return [server.id, false] as const;
        }
      }));
      if (!cancelled && settingsSessionRef.current === session) {
        setVulcanServerStatuses(Object.fromEntries(results));
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOpen, vulcanServers]);

  // Provider polling keeps both connection state and model discovery live.
  // A successful /models response supplies the provider's current model list;
  // an unreachable provider contributes no models until it comes back online.
  useEffect(() => {
    if (!isOpen || providers.length === 0) {
      if (providers.length === 0) {
        setProviderStatuses({});
        setDiscoveredModels([]);
      }
      return;
    }
    let cancelled = false;
    const scan = async () => {
      const results = await Promise.all(providers.map(async (provider) => {
        try {
          const models = await listModelsForProvider(provider);
          return {
            providerId: provider.id,
            online: true,
            models: models.map((model) => ({ id: model.id, providerId: provider.id })),
          };
        } catch {
          return { providerId: provider.id, online: false, models: [] as Array<{ id: string; providerId: string }> };
        }
      }));
      if (cancelled) return;
      setProviderStatuses(Object.fromEntries(results.map((result) => [result.providerId, result.online])));
      setDiscoveredModels(results.flatMap((result) => result.models));
    };
    void scan();
    const timer = window.setInterval(() => { void scan(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOpen, providers]);

  const [collapsedKits, setCollapsedKits] = useState<Set<string>>(() => {
    // All kits collapsed by default — populated when kits load
    return new Set();
  });

  // Collapse all kits by default whenever the kits list changes
  const allKitNames = kits.map((k) => k.kit_name).join(',');
  const [initializedKits, setInitializedKits] = useState('');
  if (allKitNames !== initializedKits && allKitNames !== '') {
    setInitializedKits(allKitNames);
    setCollapsedKits(new Set(kits.map((k) => k.kit_name)));
  }

  const toggleKitCollapsed = (kitName: string) => {
    setCollapsedKits((prev) => {
      const next = new Set(prev);
      if (next.has(kitName)) next.delete(kitName);
      else next.add(kitName);
      return next;
    });
  };

  const toggleSkillPackage = (stem: string) => {
    setExpandedSkillPackages((previous) => {
      const next = new Set(previous);
      if (next.has(stem)) next.delete(stem);
      else next.add(stem);
      return next;
    });
  };

  const toggleTool = (toolKey: string) => {
    onToggleDisabledTool(toolKey);
  };

  const enableAllInKit = (kit: KitWithTools) => {
    onEnableAllToolsInKit(kit.kit_name);
  };


  const handleSaveLLM = async () => {
    const name = providerName.trim();
    const baseUrl = llmUrl.trim().replace(/\/$/, '');

    setProviderSaveError('');
    if (!name) {
      setProviderSaveStatus('error');
      setProviderSaveError('Provider name is required.');
      return;
    }
    if (!baseUrl) {
      setProviderSaveStatus('error');
      setProviderSaveError('API base URL is required.');
      return;
    }

    // randomUUID is not available in every Electron/file:// renderer context.
    const id = editingProviderId ?? (
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `provider-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );
    const provider: ProviderConfig = { id, name, baseUrl, apiKey: llmKey, networkPointOfView: providerNetworkPointOfView };
    const existingIndex = providers.findIndex((p) => p.id === id);
    const next = existingIndex >= 0
      ? providers.map((p) => p.id === id ? provider : p)
      : [...providers, provider];

    if (!(await saveProviders(next))) {
      setProviderSaveStatus('error');
      setProviderSaveError('Could not persist the provider registry on this client.');
      return;
    }

    const persisted = loadProviders();
    const savedProvider = persisted.find((p) => p.id === id);
    if (!savedProvider || savedProvider.name !== name || savedProvider.baseUrl !== baseUrl || savedProvider.networkPointOfView !== providerNetworkPointOfView) {
      setProviderSaveStatus('error');
      setProviderSaveError('Provider save could not be verified.');
      return;
    }

    setProviders(persisted);
    setProviderName(savedProvider.name);
    setLlmUrl(savedProvider.baseUrl);
    setLlmKey(savedProvider.apiKey);
    setProviderNetworkPointOfView(savedProvider.networkPointOfView === 'server' ? 'server' : 'client');

    if (llmConfig.providerId === id) {
      onLLMConfigChange({ baseUrl: savedProvider.baseUrl, apiKey: savedProvider.apiKey });
    }
    setEditingProviderId(id);
    setProviderSaveStatus('saved');
  };

  const editProvider = (provider: ProviderConfig) => {
    setEditingProviderId(provider.id);
    setProviderName(provider.name);
    setLlmUrl(provider.baseUrl);
    setLlmKey(provider.apiKey);
    setProviderNetworkPointOfView(provider.networkPointOfView === 'server' ? 'server' : 'client');
    setShowKey(false);
    setInferenceTestStatus('idle');
    setProviderSaveStatus('idle');
    setProviderSaveError('');
  };

  const deleteProvider = async (provider: ProviderConfig) => {
    const next = providers.filter((p) => p.id !== provider.id);
    if (!(await saveProviders(next))) {
      setProviderSaveStatus('error');
      setProviderSaveError('Could not delete the provider on the Vulcan server.');
      return;
    }
    setProviders(loadProviders());
    setProviderStatuses((prev) => {
      const copy = { ...prev };
      delete copy[provider.id];
      return copy;
    });
    setDiscoveredModels((prev) => prev.filter((m) => m.providerId !== provider.id));

    if (editingProviderId === provider.id) newProvider();

    if (llmConfig.providerId === provider.id) {
      const fallback = next[0];
      onLLMConfigChange(fallback
        ? { providerId: fallback.id, baseUrl: fallback.baseUrl, apiKey: fallback.apiKey, model: '' }
        : { providerId: undefined, baseUrl: '', apiKey: '', model: '' });
    }
  };

  const confirmDelete = () => {
    if (!deleteConfirm) return;

    if (deleteConfirm.kind === 'provider') {
      void deleteProvider(deleteConfirm.provider);
    } else if (deleteConfirm.kind === 'etna') {
      void deleteEtnaServer(deleteConfirm.server);
    } else if (deleteConfirm.kind === 'server') {
      const server = deleteConfirm.server;
      if (server.url === activeVulcanEndpoint) return;
      const next = vulcanServers.filter((item) => item.id !== server.id);
      if (saveVulcanServerProfiles(next)) {
        setVulcanServers(next);
        if (editingVulcanServerId === server.id) newVulcanServer();
      }
    } else {
      forgetTrustedHarness(deleteConfirm.harness.pinKey);
      refreshTrustedHarnesses();
    }
    setDeleteConfirm(null);
  };

  const newProvider = () => {
    setEditingProviderId(null);
    setProviderName('');
    setLlmUrl('');
    setLlmKey('');
    setProviderNetworkPointOfView('client');
    setShowKey(false);
    setInferenceTestStatus('idle');
    setProviderSaveStatus('idle');
    setProviderSaveError('');
  };

  const refreshProviders = async () => {
    const statuses: Record<string, boolean> = {};
    const found: Array<{ id: string; providerId: string }> = [];
    await Promise.all(providers.map(async (provider) => {
      try {
        const models = await listModelsForProvider(provider);
        statuses[provider.id] = true;
        found.push(...models.map((m) => ({ id: m.id, providerId: provider.id })));
      } catch {
        statuses[provider.id] = false;
      }
    }));
    setProviderStatuses(statuses);
    setDiscoveredModels(found);
    await onTestInferenceConnection();
  };

  // Continuously observe the Vulcan endpoint currently entered in the editor.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const session = settingsSessionRef.current;
    // A changed endpoint starts pending, while routine re-polls leave the
    // current visual state intact until their result arrives.
    setVulcanEndpointTestStatus('testing');
    const poll = async () => {
      const candidate = vulcanEndpointInput.trim().replace(/\/$/, '');
      if (!candidate) {
        if (!cancelled && settingsSessionRef.current === session) setVulcanEndpointTestStatus('fail');
        return;
      }
      try {
        const res = await fetch(`${candidate}/ping`);
        if (!cancelled && settingsSessionRef.current === session) setVulcanEndpointTestStatus(res.ok ? 'ok' : 'fail');
      } catch {
        if (!cancelled && settingsSessionRef.current === session) setVulcanEndpointTestStatus('fail');
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOpen, vulcanEndpointInput]);

  const newVulcanServer = () => {
    setEditingVulcanServerId(null);
    setVulcanServerName('');
    setVulcanEndpointInput('');
    setVulcanServerSaveStatus('idle');
    setVulcanServerSaveError('');
    setVulcanEndpointTestStatus('idle');
  };

  const editVulcanServer = (server: VulcanServerProfile) => {
    setEditingVulcanServerId(server.id);
    setVulcanServerName(server.name);
    setVulcanEndpointInput(server.url);
    setVulcanServerSaveStatus('idle');
    setVulcanServerSaveError('');
  };

  const saveVulcanServer = () => {
    const name = vulcanServerName.trim();
    setVulcanServerSaveError('');
    if (!name) {
      setVulcanServerSaveStatus('error');
      setVulcanServerSaveError('Server name is required.');
      return;
    }

    let url: string;
    try {
      url = normalizeVulcanServerUrl(vulcanEndpointInput);
    } catch (error: any) {
      setVulcanServerSaveStatus('error');
      setVulcanServerSaveError(error?.message ?? 'Enter a valid HTTP or HTTPS server address.');
      return;
    }

    const existing = editingVulcanServerId
      ? vulcanServers.find((server) => server.id === editingVulcanServerId)
      : undefined;
    if (existing?.url === activeVulcanEndpoint && url !== activeVulcanEndpoint) {
      setVulcanServerSaveStatus('error');
      setVulcanServerSaveError('Switch to another server before changing the active server address.');
      return;
    }
    if (vulcanServers.some((server) => server.url === url && server.id !== editingVulcanServerId)) {
      setVulcanServerSaveStatus('error');
      setVulcanServerSaveError('This server address is already saved.');
      return;
    }

    const profile: VulcanServerProfile = {
      id: editingVulcanServerId ?? newVulcanServerProfileId(),
      name,
      url,
    };
    const next = existing
      ? vulcanServers.map((server) => server.id === profile.id ? profile : server)
      : [...vulcanServers, profile];
    if (!saveVulcanServerProfiles(next)) {
      setVulcanServerSaveStatus('error');
      setVulcanServerSaveError('Could not save the server profile.');
      return;
    }
    setVulcanServers(next);
    setEditingVulcanServerId(profile.id);
    setVulcanEndpointInput(url);
    setVulcanServerSaveStatus('saved');
  };

  const switchVulcanServer = async (profile: VulcanServerProfile) => {
    setVulcanServerSaveError('');
    try {
      await onSwitchVulcanServer(profile);
      setProviders(loadProviders());
      newProvider();
    } catch (error: any) {
      setVulcanServerSaveError(error?.message ?? 'Could not switch Vulcan servers.');
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const names: Record<string, string> = {};
    for (const server of etnaServers) {
      for (const item of ((server as any).skills || [])) {
        if (typeof item?.source === 'string' && item.source.startsWith('kits/')) names[item.source] = item.name;
      }
    }
    setKitSkillNames(names);
  }, [isOpen, kits, etnaServers]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void Promise.all(skills.map(async (skill) => {
      try {
        return [skill.stem, (await listSkillPackageFiles(skill)).length] as const;
      } catch {
        return [skill.stem, 0] as const;
      }
    })).then((entries) => {
      if (!cancelled) setSkillFileCounts(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [isOpen, skillFileCountKey]);

  if (!isOpen) return null;

  const tabs = [
    { id: 'server', label: 'Etna' },
    { id: 'llm', label: 'Providers' },
    { id: 'vulcan', label: 'Vulcan' },
    { id: 'security', label: 'Security' },
    { id: 'kits', label: `Kits (${kits.length})` },
    { id: 'skills', label: `Skills (${skills.length})` },
  ] as const;
  const skillCategories = [
    { id: 'vulcan' as const, label: 'Vulcan', items: skills.filter((skill) => skill.source === 'vulcan') },
    { id: 'etna' as const, label: 'Etna', items: skills.filter((skill) => skill.source !== 'vulcan') },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm px-4 pt-6 pb-4">
      <div className="bg-ash-900 border border-ash-800 rounded-lg shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-ash-800">
          <h2 className="text-lg font-semibold text-ash-100">Settings</h2>
          <button onClick={onClose} className="p-1 hover:bg-ash-800 rounded-md transition-colors">
            <X className="w-5 h-5 text-ash-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-ash-800">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                activeTab === tab.id
                  ? 'border-coral-500 text-coral-400'
                  : 'border-transparent text-ash-400 hover:text-ash-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">

          {/* Etna Servers */}
          {activeTab === 'server' && (
            <div className="space-y-4">
              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {editingEtnaServerId ? (<>
                      <span className="text-sm font-medium text-ash-300">Editing</span>
                      <span className="max-w-[16rem] truncate rounded-md border border-ash-700 bg-ash-800/80 px-2 py-0.5 font-mono text-xs text-ash-200">{etnaServers.find((server) => server.id === editingEtnaServerId)?.name ?? etnaServerName}</span>
                    </>) : <span className="text-sm font-medium text-ash-300">Add Server</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {editingEtnaServerId && <button type="button" onClick={newEtnaServer} className="px-3 py-2 bg-ash-800 hover:bg-ash-700 text-ash-300 rounded-md text-sm font-medium transition-colors">+ New</button>}
                    <button type="button" onClick={() => void saveEtnaServer()} className="px-4 py-2 bg-coral-500 hover:bg-coral-600 text-white rounded-md text-sm font-medium transition-colors">Save</button>
                  </div>
                </div>
                <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-3 rounded-md bg-ash-800/50 p-3">
                  <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">Server Name</label>
                  <input value={etnaServerName} onChange={(e) => setEtnaServerName(e.target.value)} className="w-full bg-ash-800 border border-ash-700 rounded-md px-3 py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500" placeholder="Laptop" />
                  <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">Server URL</label>
                  <div className="relative min-w-0">
                    <input value={etnaUrlInput} onChange={(e) => { setEtnaUrlInput(e.target.value); setEtnaEditorStatus('idle'); }} className="w-full bg-ash-800 border border-ash-700 rounded-md pl-3 pr-[8.7rem] py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500" placeholder="http://localhost:8467" />
                    <span className="absolute inset-y-0 right-3 flex items-center gap-2">
                      <NetworkPointOfViewToggle value={etnaNetworkPointOfView} onChange={setEtnaNetworkPointOfView} />
                      <span className={`connection-status-dot ${etnaEditorStatus === 'ok' ? 'connection-status-dot-green connection-status-dot-live' : 'connection-status-dot-gray'}`} />
                    </span>
                  </div>
                </div>
                {etnaSaveError && <p className="mt-2 text-right text-xs text-red-400">{etnaSaveError}</p>}
              </section>

              <section className="pt-4 border-t border-ash-800">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-ash-300">Etna Servers</h3>
                  <span className="text-xs text-ash-500">{etnaServers.length} configured</span>
                </div>
                <div className="max-h-52 overflow-y-auto rounded-md border border-ash-700 divide-y divide-ash-700">
                  {etnaServers.length === 0 ? <div className="p-4 text-sm text-ash-500">No Etna servers configured.</div> : etnaServers.map((server) => {
                    const hasConflict = etnaSummary.conflictServerIds.includes(server.id);
                    return <div key={server.id} className="w-full flex items-center gap-3 px-3 py-2.5 bg-ash-850 hover:bg-ash-800 transition-colors">
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${server.healthy ? 'bg-green-400 provider-online-dot' : 'bg-ash-600'}`} title={server.healthy ? 'Connected' : 'No connection'} />
                      <button onClick={() => editEtnaServer(server)} className="min-w-0 flex-1 text-left">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm text-ash-100">{server.name}</span>
                          <span className="rounded-full border border-coral-400/30 bg-coral-500/10 px-2 py-0.5 text-[9px] font-semibold tracking-wide text-coral-400">{server.networkPointOfView === 'server' ? 'SERVER' : 'CLIENT'}</span>
                        </div>
                        <div className="text-xs text-ash-500 truncate">{server.url}</div>
                      </button>
                      {hasConflict && <span className="flex shrink-0 items-center gap-1 rounded-full border border-yellow-300/20 bg-yellow-300/10 px-2 py-1 text-[10px] font-medium text-yellow-200/80" title="Resolve routing conflicts in the Kits tab"><AlertTriangle className="h-3 w-3" />Conflicts found, resolve in the Kits tab</span>}
                      <button
                        type="button"
                        onClick={() => void toggleEtnaServerEnabled(server)}
                        className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors ${
                          server.enabled ? 'bg-coral-500' : 'bg-ash-700'
                        }`}
                        title={server.enabled ? 'Disable Etna server' : 'Enable Etna server'}
                        aria-label={server.enabled ? `Disable ${server.name}` : `Enable ${server.name}`}
                        aria-pressed={server.enabled}
                      >
                        <div className={`absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                          server.enabled ? 'translate-x-5' : 'translate-x-0'
                        }`} />
                      </button>
                      <button onClick={() => editEtnaServer(server)} className="text-xs text-ash-500 hover:text-ash-200 transition-colors">Edit</button>
                      <button onClick={() => setDeleteConfirm({ kind: 'etna', server })} className="text-xs text-ash-500 hover:text-red-400 transition-colors">Delete</button>
                    </div>;
                  })}
                </div>
              </section>

              <section className="pt-4 border-t border-ash-800">
                <h3 className="text-sm font-medium text-ash-300 mb-3">Server Info</h3>
                <div className="bg-ash-800/50 rounded-md p-3 text-sm">
                  <div className="grid grid-cols-[8rem_1px_minmax(0,1fr)] items-stretch gap-x-3">
                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Servers:</div>
                    <div className="row-span-4 bg-ash-700/80" aria-hidden="true" />
                    <div className="flex min-h-8 items-center text-ash-100">{etnaSummary.servers}</div>
                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Kits:</div>
                    <div className="flex min-h-8 items-center text-ash-100">{etnaSummary.kits}</div>
                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Tools:</div>
                    <div className="flex min-h-8 items-center text-ash-100">{etnaSummary.tools}</div>
                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Connections:</div>
                    <div className="flex min-h-8 items-center gap-2 text-ash-100" title="Based on the number of Etna servers with a healthy connection">
                      {(() => { const total = etnaSummary.configured; const healthy = etnaSummary.healthy; const ratio = total ? healthy / total : 0; const cls = healthy === 0 ? 'connection-status-dot-gray' : ratio === 1 ? 'connection-status-dot-green connection-status-dot-live' : ratio >= .75 ? 'connection-status-dot-yellow connection-status-dot-live' : ratio >= .5 ? 'connection-status-dot-orange connection-status-dot-live' : 'connection-status-dot-red connection-status-dot-live'; return <span className={`connection-status-dot ${cls}`} />; })()}
                      <span>{etnaSummary.healthy} / {etnaSummary.configured}</span>
                    </div>
                  </div>
                </div>
                <button onClick={onRefresh} className="mt-3 flex items-center gap-2 px-3 py-2 bg-ash-800 hover:bg-ash-700 text-ash-300 rounded-md text-sm font-medium transition-colors"><RefreshCw className="w-4 h-4" />Refresh Connections</button>
              </section>
            </div>
          )}

          {activeTab === 'security' && (
            <div className="space-y-4">
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-coral-400" />
                  <h3 className="text-sm font-medium text-ash-300">Trusted Harnesses</h3>
                </div>
                <p className="mb-4 text-xs leading-5 text-ash-500">
                  Vulcan remembers the Ed25519 identity presented by each harness. A changed identity blocks the connection before a password is requested.
                </p>
                {trustedHarnesses.length === 0 ? (
                  <div className="rounded-md border border-ash-800 bg-ash-800/40 p-4 text-sm text-ash-500">No harness identities are currently trusted.</div>
                ) : (
                  <div className="space-y-2">
                    {trustedHarnesses.map((harness) => (
                      <div key={harness.pinKey} className="rounded-md border border-ash-800 bg-ash-800/40 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 text-sm">
                            <span className="text-ash-500">Address: </span>
                            <span className="font-mono text-ash-200">{harness.endpoint}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              onClick={() => { void copyHarnessFingerprint(harness.pinKey, harness.fingerprint); }}
                              className={`rounded p-2 transition-all ${
                                copiedHarnessPinKey === harness.pinKey
                                  ? 'bg-green-500/15 text-green-400 opacity-80'
                                  : 'text-ash-500 hover:bg-ash-700/70 hover:text-ash-300'
                              }`}
                              title={copiedHarnessPinKey === harness.pinKey ? 'Copied' : 'Copy fingerprint'}
                            >
                              {copiedHarnessPinKey === harness.pinKey
                                ? <ClipboardCheck className="h-4 w-4" />
                                : <Clipboard className="h-4 w-4" />}
                            </button>
                            <button
                              onClick={() => setDeleteConfirm({ kind: 'harness', harness })}
                              className="rounded p-2 text-ash-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                              title="Forget trusted identity"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 select-text break-all font-mono text-[11px] leading-4 text-blue-400">{harness.fingerprint}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Providers */}
          {activeTab === 'llm' && (
            <div className="space-y-4">
              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  {editingProviderId ? (
                    <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-ash-300">
                      <span>Editing</span>
                      <span className="max-w-56 truncate rounded-md border border-ash-700 bg-ash-800/80 px-1.5 py-0.5 font-mono text-[12px] font-normal leading-4 text-ash-200">
                        {providers.find((provider) => provider.id === editingProviderId)?.name || providerName || 'Provider'}
                      </span>
                    </div>
                  ) : (
                    <h3 className="text-sm font-medium text-ash-300">Add Provider</h3>
                  )}
                  <div className="flex items-center gap-2">
                    {editingProviderId && (
                      <button
                        type="button"
                        onClick={newProvider}
                        className="px-3 py-1.5 bg-ash-800 hover:bg-ash-700 text-ash-300 rounded-md text-sm"
                      >
                        + New
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleSaveLLM}
                      className={`w-24 whitespace-nowrap px-3 py-1.5 text-white rounded-md text-sm font-medium transition-colors ${
                        providerSaveStatus === 'error'
                          ? 'bg-red-600 hover:bg-red-500'
                          : 'bg-coral-500 hover:bg-coral-600'
                      }`}
                    >
                      {providerSaveStatus === 'saved' ? 'Saved' : 'Save'}
                    </button>
                  </div>
                </div>

                <div className="bg-ash-800/50 rounded-md p-3">
                  <div className="grid grid-cols-[8.5rem_1px_minmax(0,1fr)] items-stretch gap-x-3 gap-y-3">
                  <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">Provider Name</label>
                  <div className="row-span-3 bg-ash-700/80" aria-hidden="true" />
                  <div className="flex min-h-10 min-w-0 items-center">
                    <input
                      value={providerName}
                      onChange={(e) => { setProviderName(e.target.value); setProviderSaveStatus('idle'); setProviderSaveError(''); }}
                      className="w-full bg-ash-800 border border-ash-700 rounded-md px-3 py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500"
                      placeholder="Local"
                    />
                  </div>

                  <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">API Base URL</label>
                  <div className="flex min-h-10 min-w-0 items-center">
                    <div className="relative w-full">
                      <input
                        value={llmUrl}
                        onChange={(e) => { setLlmUrl(e.target.value); setProviderSaveStatus('idle'); setProviderSaveError(''); }}
                        className="w-full bg-ash-800 border border-ash-700 rounded-md pl-3 pr-36 py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500"
                        placeholder="http://localhost:11434/v1"
                      />
                      <span className="absolute inset-y-0 right-7 flex items-center">
                        <NetworkPointOfViewToggle
                          value={providerNetworkPointOfView}
                          onChange={(networkPointOfView) => {
                            setProviderNetworkPointOfView(networkPointOfView);
                            setProviderSaveStatus('idle');
                            setProviderSaveError('');
                          }}
                        />
                      </span>
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center justify-center" title={inferenceTestStatus === 'ok' ? 'Connected' : 'Disconnected'}>
                        <span className={`connection-status-dot ${inferenceTestStatus === 'ok' ? 'connection-status-dot-green connection-status-dot-live' : 'bg-ash-600'}`} />
                      </span>
                    </div>
                  </div>

                  <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">
                    API Key
                  </label>
                  <div className="flex min-h-10 min-w-0 items-center">
                    <div className="relative w-full">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={llmKey}
                        onChange={(e) => { setLlmKey(e.target.value); setProviderSaveStatus('idle'); setProviderSaveError(''); }}
                        className="w-full bg-ash-800 border border-ash-700 rounded-md px-3 py-2 pr-10 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500"
                        placeholder="Optional"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-ash-500 hover:text-ash-300"
                        title={showKey ? 'Hide API key' : 'Show API key'}
                      >
                        {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  </div>
                </div>

                {providerSaveError && <p className="mt-2 text-right text-xs text-red-400">{providerSaveError}</p>}
              </section>

              <section className="pt-4 border-t border-ash-800">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-ash-300">Providers</h3>
                  <span className="text-xs text-ash-500">{providers.length} configured</span>
                </div>
                <div className="max-h-44 overflow-y-auto rounded-md border border-ash-700 divide-y divide-ash-700">
                  {providers.length === 0 ? <div className="p-4 text-sm text-ash-500">No providers configured.</div> : providers.map((provider) => {
                    const online = providerStatuses[provider.id];
                    return <div key={provider.id} className="w-full flex items-center gap-3 px-3 py-2.5 bg-ash-850 hover:bg-ash-800 transition-colors">
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${online ? 'bg-green-400 provider-online-dot' : 'bg-ash-600'}`} title={online ? 'Connected' : 'No connection'} />
                      <button onClick={() => editProvider(provider)} className="min-w-0 flex-1 text-left">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm text-ash-100">{provider.name}</span>
                          <span className="rounded-full border border-coral-400/30 bg-coral-500/10 px-2 py-0.5 text-[9px] font-semibold tracking-wide text-coral-400">
                            {(provider.networkPointOfView === 'server' ? 'SERVER' : 'CLIENT')}
                          </span>
                        </div>
                        <div className="text-xs text-ash-500 truncate">{provider.baseUrl}</div>
                      </button>
                      <button onClick={() => editProvider(provider)} className="text-xs text-ash-500 hover:text-ash-200 transition-colors">Edit</button>
                      <button onClick={() => setDeleteConfirm({ kind: 'provider', provider })} className="text-xs text-ash-500 hover:text-red-400 transition-colors">Delete</button>
                    </div>;
                  })}
                </div>
              </section>

              <section className="pt-4 border-t border-ash-800">
                <h3 className="text-sm font-medium text-ash-300 mb-3">Models &amp; Connections</h3>
                <div className="bg-ash-800/50 rounded-md p-3 text-sm">
                  <div className="grid grid-cols-[8.5rem_1px_minmax(0,1fr)] items-stretch gap-x-3">
                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Selected model:</div>
                    <div className="row-span-3 bg-ash-700/80" aria-hidden="true" />
                    <div className="flex min-h-8 min-w-0 items-center justify-start">
                      <span className="min-w-0 truncate text-left text-ash-100">{llmConfig.model || 'None'}</span>
                    </div>

                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Provider:</div>
                    <div className="flex min-h-8 min-w-0 items-center justify-start">
                      <span className="min-w-0 truncate text-left text-ash-100">{providers.find((p) => p.id === llmConfig.providerId)?.name || 'None'}</span>
                    </div>

                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Discovered models:</div>
                    <div className="flex min-h-8 items-center justify-start text-left text-ash-100">{discoveredModels.length}</div>
                  </div>
                </div>
                <button onClick={refreshProviders} className="mt-3 flex items-center gap-2 px-3 py-2 bg-ash-800 hover:bg-ash-700 text-ash-300 rounded-md text-sm font-medium transition-colors"><RefreshCw className="w-4 h-4" />Refresh All Models / Connections</button>
              </section>
            </div>
          )}

          {/* Kits */}
          {activeTab === 'kits' && (
            <div className="space-y-2">
              {/* Info card */}
              <div className="bg-ash-800/50 rounded-md p-3 mb-3 space-y-2">
                <div>
                  <p className="text-sm text-ash-200">Kit &amp; Tool Access</p>
                  <p className="text-xs text-ash-500 mt-0.5">Controls what the agent can see and use during a conversation.</p>
                </div>
                <div className="pt-2 border-t border-ash-700/50 text-xs text-ash-500 space-y-1">
                  <ul className="list-disc pl-4 space-y-0.5 text-ash-600">
                    <li>Enabling or disabling kits and their individual tools controls what the agent can access.</li>
                    <li>In <span className="text-ash-400 font-medium">Search Mode</span> <span className="text-ash-700">(Vulcan → Tool Mode)</span>, the agent must actively search for and discover available tools — keeping context lean for longer tasks.</li>
                    <li>In <span className="text-ash-400 font-medium">Broad Mode</span>, all enabled kits and tools are shown to the agent upfront.</li>
                  </ul>
                </div>
              </div>
              {etnaLogicalKits.length === 0 ? (
                <div className="text-center text-ash-500 py-8">
                  No kits available. Check your server connections.
                </div>
              ) : (
                etnaLogicalKits.map((kit) => {
                  const logicalKit = etnaLogicalKits.find((k) => k.kit_name === kit.kit_name) ?? etnaLogicalKits.find((k) => k.logical_id === (kit as any).logical_id);
                  const kitWithTools = logicalKit ?? kitsWithTools.find((k) => k.kit_name === kit.kit_name);
                  const tools = kitWithTools?.tools ?? [];
                  const isCollapsed = collapsedKits.has(kit.kit_name);
                  const hasDisabled = tools.some((t) => disabledTools.has(`${kit.kit_name}::${t.name}`));

                  return (
                    <div key={kit.kit_name} className="bg-ash-850 border border-ash-700 rounded-lg overflow-hidden">
                      {/* Kit header */}
                      <div className="flex items-start gap-2 px-3 py-3 transition-colors hover:bg-ash-800">
                        <button
                          onClick={() => toggleKitCollapsed(kit.kit_name)}
                          aria-expanded={!isCollapsed}
                          className="flex items-start gap-2 flex-1 text-left group min-w-0"
                        >
                          {isCollapsed
                            ? <ChevronRight className="mt-0.5 w-4 h-4 text-ash-400 group-hover:text-ash-200 transition-colors flex-shrink-0" />
                            : <ChevronDown className="mt-0.5 w-4 h-4 text-ash-400 group-hover:text-ash-200 transition-colors flex-shrink-0" />
                          }
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="font-medium text-ash-100 group-hover:text-white transition-colors">{kit.kit_name}</span>
                              <span className="text-xs text-ash-500 flex-shrink-0">({tools.length} {tools.length === 1 ? 'tool' : 'tools'})</span>
                            </span>
                            {kit.kit_description && (
                              <span className="mt-0.5 block line-clamp-4 whitespace-normal text-xs leading-5 text-ash-500">{kit.kit_description}</span>
                            )}
                          </span>
                        </button>
                        {kit.sources.length > 1 && (
                          <select
                            value={kit.selected_server_id ?? ''}
                            onChange={(event) => void setEtnaRouteChoice(kit.logical_id, event.target.value || null)}
                            onClick={(event) => event.stopPropagation()}
                            className={`mt-0.5 max-w-[12rem] shrink-0 rounded-md border px-2 py-1 text-xs outline-none ${kit.unresolved_conflict ? 'border-yellow-300/30 bg-yellow-300/10 text-yellow-100' : 'border-ash-700 bg-ash-900 text-ash-300'}`}
                            title="Choose which Etna server provides this deduplicated kit"
                          >
                            <option value="">Select server...</option>
                            {kit.sources.map((source) => <option key={source.serverId} value={source.serverId}>{source.name}</option>)}
                          </select>
                        )}
                        {hasDisabled && (
                          <button
                            onClick={() => enableAllInKit(kitWithTools!)}
                            className="text-xs px-2 py-0.5 rounded bg-coral-500/20 text-coral-400 hover:bg-coral-500/40 transition-colors whitespace-nowrap flex-shrink-0"
                          >
                            Enable All
                          </button>
                        )}
                        {/* Kit enable/disable toggle */}
                        <div className="mt-1 flex-shrink-0 flex items-center gap-1.5">
                          <button
                            onClick={(e) => { e.stopPropagation(); onToggleKit(kit.kit_name, !kit.enabled); }}
                            className={`relative flex-shrink-0 w-8 h-4 rounded-full transition-colors ${kit.enabled ? 'bg-coral-500' : 'bg-ash-700'}`}
                          >
                            <div className={`absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${kit.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                          </button>
                        </div>
                      </div>

                      {!isCollapsed && kitWithTools && (
                        <div className="border-t border-ash-700/50 bg-ash-900/40 px-3 py-3">
                          <KitContentsExplorer
                            kit={kitWithTools}
                            skillName={kit.skill ? kitSkillNames[kit.skill] : undefined}
                            disabledTools={disabledTools}
                            onToggleTool={toggleTool}
                          />
                        </div>
                      )}

                      {!isCollapsed && kit.enabled && tools.length === 0 && (
                        <div className="border-t border-ash-700/50 px-4 py-3 text-xs text-ash-500">
                          No tools loaded yet — try refreshing.
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}


          {/* Skills */}
          {activeTab === 'skills' && (
            <div className="space-y-2">
              <div className="bg-ash-800/50 rounded-md p-3 mb-3">
                <p className="text-sm text-ash-200">Skills</p>
                <p className="text-xs text-ash-500 mt-0.5">Enabled Vulcan and Etna skills are visible to the model. Kit skills remain available when their kit is enabled.</p>
              </div>
              <div
                role="tablist"
                aria-label="Skill category"
                className="inline-flex rounded-full border border-ash-700 bg-ash-800 p-1"
              >
                {skillCategories.map((category) => (
                  <button
                    key={category.id}
                    id={`vulcan-skill-tab-${category.id}`}
                    type="button"
                    role="tab"
                    aria-selected={activeSkillCategory === category.id}
                    aria-controls={`vulcan-skill-panel-${category.id}`}
                    onClick={() => setActiveSkillCategory(category.id)}
                    className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                      activeSkillCategory === category.id
                        ? 'bg-coral-500 text-white'
                        : 'text-ash-400 hover:text-ash-200'
                    }`}
                  >
                    {category.label}
                    <span className="ml-1.5 text-xs opacity-75">{category.items.length}</span>
                  </button>
                ))}
              </div>
              {skillCategories.filter((category) => category.id === activeSkillCategory).map((category) => (
                <section
                  key={category.id}
                  id={`vulcan-skill-panel-${category.id}`}
                  role="tabpanel"
                  aria-labelledby={`vulcan-skill-tab-${category.id}`}
                  className="min-w-0 space-y-2 pt-2"
                >
                  <div className="flex items-center justify-between px-1">
                    <p className="text-sm font-medium text-ash-300">{category.label}</p>
                    <span className="text-xs text-ash-500">{category.items.length} configured</span>
                  </div>
                  <div className="space-y-2">
                    {category.items.length === 0 ? (
                      <div className="p-4 text-sm text-ash-500">
                        {category.label === 'Etna'
                          ? <>No Etna skills installed. Use <span className="font-mono text-ash-400">etna install &lt;skill-name&gt;</span> to add one.</>
                          : 'No Vulcan skills available.'}
                      </div>
                    ) : category.items.map((skill) => {
                      const expanded = expandedSkillPackages.has(skill.stem);
                      const panelId = `vulcan-skill-files-${skill.stem}`;
                      const fileCount = skillFileCounts[skill.stem];
                      const displayName = formatSkillDisplayName(skill.name);
                      return (
                        <div key={skill.stem} className="overflow-hidden rounded-lg border border-ash-700 bg-ash-850">
                          <div className="flex items-start gap-2 px-3 py-3 transition-colors hover:bg-ash-800">
                            <button
                              type="button"
                              aria-expanded={expanded}
                              aria-controls={panelId}
                              onClick={() => toggleSkillPackage(skill.stem)}
                              className="flex min-w-0 flex-1 items-start gap-2 text-left"
                            >
                              {expanded
                                ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-ash-400" />
                                : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-ash-400" />}
                              <span className="min-w-0 flex-1">
                                <span className="flex items-baseline gap-2">
                                  <span className="text-sm text-ash-100">{displayName}</span>
                                  <span className="shrink-0 text-xs text-ash-500">
                                    ({fileCount === undefined ? '… files' : `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`})
                                  </span>
                                </span>
                                {skill.description && (
                                  <span className={`mt-0.5 block text-xs leading-5 text-ash-500 ${expanded ? 'whitespace-normal' : 'truncate'}`}>
                                    {skill.description}
                                  </span>
                                )}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onToggleSkill(skill.stem, !skill.enabled)}
                              aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${category.label} skill ${displayName}`}
                              className={`relative mt-1 flex-shrink-0 w-8 h-4 rounded-full transition-colors ${skill.enabled ? 'bg-coral-500' : 'bg-ash-700'}`}
                            >
                              <div className={`absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${skill.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                            </button>
                          </div>
                          {expanded && (
                            <div id={panelId} className="border-t border-ash-700/50 bg-ash-900/40 px-3 py-3">
                              <SkillPackageExplorer skill={skill} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          {/* Vulcan Settings */}
          {activeTab === 'vulcan' && (
            <div className="space-y-4">
              {/* Server bookmarks are client-owned; switching is always explicit. */}
              <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-ash-300">{editingVulcanServerId ? 'Edit Server' : 'Add Server'}</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={saveVulcanServer}
                      className={`w-24 whitespace-nowrap px-3 py-1.5 text-white rounded-md text-sm font-medium transition-colors ${vulcanServerSaveStatus === 'error' ? 'bg-red-600 hover:bg-red-500' : 'bg-coral-500 hover:bg-coral-600'}`}
                    >
                      {vulcanServerSaveStatus === 'saved' ? 'Saved' : 'Save'}
                    </button>
                    <button type="button" onClick={newVulcanServer} className="px-3 py-1.5 bg-ash-800 hover:bg-ash-700 text-ash-300 rounded-md text-sm">+ New</button>
                  </div>
                </div>
                <div className="bg-ash-800/50 rounded-md p-3">
                  <div className="grid grid-cols-[8.5rem_1px_minmax(0,1fr)] items-stretch gap-x-3 gap-y-3">
                    <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">Server Name</label>
                    <div className="row-span-2 bg-ash-700/80" aria-hidden="true" />
                    <div className="flex min-h-10 min-w-0 items-center">
                      <input value={vulcanServerName} onChange={(event) => { setVulcanServerName(event.target.value); setVulcanServerSaveStatus('idle'); setVulcanServerSaveError(''); }} className="w-full bg-ash-800 border border-ash-700 rounded-md px-3 py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500" placeholder="Local" />
                    </div>
                    <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">Server URL</label>
                    <div className="flex min-h-10 min-w-0 items-center">
                      <div className="relative w-full">
                        <input value={vulcanEndpointInput} onChange={(event) => { setVulcanEndpointInput(event.target.value); setVulcanServerSaveStatus('idle'); setVulcanServerSaveError(''); }} className="w-full bg-ash-800 border border-ash-700 rounded-md pl-3 pr-10 py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500" placeholder="http://localhost:8468" />
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center justify-center" title={vulcanEndpointTestStatus === 'ok' ? 'Connected' : 'Disconnected'}>
                          <span className={`connection-status-dot ${vulcanEndpointTestStatus === 'ok' ? 'connection-status-dot-green connection-status-dot-live' : 'bg-ash-600'}`} />
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-xs text-ash-500">Saving a server does not change your current connection.</p>
                {vulcanServerSaveError && <p className="mt-2 text-right text-xs text-red-400">{vulcanServerSaveError}</p>}
              </section>

              <section className="pt-4 border-t border-ash-800">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-ash-300">Vulcan Servers</h3>
                  <span className="text-xs text-ash-500">{vulcanServers.length} configured</span>
                </div>
                <div className="max-h-52 overflow-y-auto rounded-md border border-ash-700 divide-y divide-ash-700">
                  {vulcanServers.map((server) => {
                    const active = server.url === activeVulcanEndpoint;
                    const online = vulcanServerStatuses[server.id];
                    return (
                      <div key={server.id} className="w-full flex items-center gap-3 px-3 py-2.5 bg-ash-850 hover:bg-ash-800 transition-colors">
                        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${online ? 'bg-green-400 provider-online-dot' : 'bg-ash-600'}`} title={online ? 'Connected' : 'No connection'} />
                        <button type="button" onClick={() => editVulcanServer(server)} className="min-w-0 flex-1 text-left">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm text-ash-100">{server.name}</span>
                            {active && <span className="rounded-full border border-green-400/25 bg-green-400/10 px-2 py-0.5 text-[9px] font-semibold tracking-wide text-green-400">ACTIVE</span>}
                          </div>
                          <div className="truncate text-xs text-ash-500">{server.url}</div>
                        </button>
                        {!active && (
                          <button type="button" disabled={isSwitchingVulcanServer} onClick={() => void switchVulcanServer(server)} className="rounded-md border border-coral-500/45 bg-coral-500/10 px-2.5 py-1 text-xs font-medium text-coral-400 transition-colors hover:bg-coral-500/20 disabled:cursor-not-allowed disabled:opacity-50">
                            {isSwitchingVulcanServer ? 'Switching…' : 'Switch'}
                          </button>
                        )}
                        <button type="button" onClick={() => editVulcanServer(server)} className="text-xs text-ash-500 hover:text-ash-200 transition-colors">Edit</button>
                        <button type="button" disabled={active} onClick={() => setDeleteConfirm({ kind: 'server', server })} title={active ? 'The active server cannot be deleted' : 'Delete server'} className="text-xs text-ash-500 transition-colors hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-35">Delete</button>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs leading-5 text-ash-500">Switching loads the selected server’s conversations and providers. Existing runs continue on their original server.</p>
              </section>

              <div className="border-t border-ash-800" />

              {/* CLI Workspace */}
              <div>
                <h3 className="text-sm font-medium text-ash-300 mb-3">CLI Workspace</h3>
                <div className="bg-ash-800/50 rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-ash-200">Enable CLI Workspace</p>
                      <p className="text-xs text-ash-500 mt-0.5">
                        Gives the agent a Docker environment with file tools, terminal access, and workspace persistence.
                      </p>
                    </div>
                    <button
                      onClick={() => onVulcanSettingsChange({ cliWorkspaceEnabled: !vulcanSettings.cliWorkspaceEnabled })}
                      className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors ${
                        vulcanSettings.cliWorkspaceEnabled ? 'bg-coral-500' : 'bg-ash-700'
                      }`}
                    >
                      <div className={`absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                        vulcanSettings.cliWorkspaceEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                  {vulcanSettings.cliWorkspaceEnabled && (
                    <div className="pt-2 border-t border-ash-700/50 text-xs text-ash-500 space-y-1">
                      <p>When enabled, the agent gains access to:</p>
                      <ul className="list-disc pl-4 space-y-0.5 text-ash-600">
                        <li>present, view_file, use_terminal, send_input, kill_process, wait</li>
                        <li>Workspace panel with file browser and terminal</li>
                        <li>Git-backed file history per conversation</li>
                        <li>Attachments are placed into the workspace and the agent is notified. The agent uses the terminal or view_file to interact with them.</li>
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* Tool Discovery */}
              <div>
                <h3 className="text-sm font-medium text-ash-300 mb-3">Tool Discovery</h3>
                <div className="bg-ash-800/50 rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-ash-200">Tool Mode</p>
                      <p className="text-xs text-ash-500 mt-0.5">
                        Controls how the agent accesses kit tools.
                      </p>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-1.5">
                      <span className="text-[10px] font-medium tracking-wide text-ash-500">
                        {vulcanSettings.toolMode === 'broad' ? 'BROAD' : 'SEARCH'}
                      </span>
                      <button
                        onClick={() => onVulcanSettingsChange({ toolMode: vulcanSettings.toolMode === 'broad' ? 'search' : 'broad' })}
                        className={`relative flex-shrink-0 w-8 h-4 rounded-full transition-colors ${vulcanSettings.toolMode === 'broad' ? 'bg-coral-500' : 'bg-ash-700'}`}
                      >
                        <div className={`absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${vulcanSettings.toolMode === 'broad' ? 'translate-x-4' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-ash-700/50 text-xs text-ash-500 space-y-1">
                    <ul className="list-disc pl-4 space-y-0.5 text-ash-600">
                      <li><span className="text-ash-500">Broad:</span> All enabled kit tools are shown upfront. Best for models with large context windows.</li>
                      <li><span className="text-ash-500">Search:</span> The agent discovers tools on demand using list_kits, search_tools, etc. Keeps the context lean.</li>
                    </ul>
                  </div>
                  {vulcanSettings.toolMode === 'search' && (
                    <div className="pt-2 border-t border-ash-700/50 flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm text-ash-200">Discovery Execution</p>
                        <p className="text-xs text-ash-500 mt-0.5">
                          Compare wrapper, indexed promotion, and search-led promotion.
                        </p>
                      </div>
                      <div className="flex-shrink-0 inline-flex rounded-full bg-ash-900/70 p-0.5 border border-ash-700/70">
                        {(['wrapper', 'promotion', 'search-inspect'] as const).map((variant) => (
                          <button
                            key={variant}
                            onClick={() => onVulcanSettingsChange({ discoveryExecution: variant })}
                            className={`rounded-full px-2 py-0.5 text-[9px] font-semibold tracking-wide transition-colors ${
                              vulcanSettings.discoveryExecution === variant
                                ? 'bg-coral-500 text-white'
                                : 'text-ash-500 hover:text-ash-300'
                            }`}
                          >
                            {variant === 'wrapper' ? 'RUN TOOL' : variant === 'promotion' ? 'PROMOTE' : 'SEARCH'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Recall */}
              <div>
                <h3 className="text-sm font-medium text-ash-300 mb-3">Recall</h3>
                <div className="bg-ash-800/50 rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-ash-200">Enable Recall</p>
                      <p className="text-xs text-ash-500 mt-0.5">
                        Lets the agent search previous conversations using keyword expansion or semantic similarity.
                      </p>
                    </div>
                    <button
                      onClick={() => onVulcanSettingsChange({ recallEnabled: !vulcanSettings.recallEnabled })}
                      className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors ${
                        vulcanSettings.recallEnabled ? 'bg-coral-500' : 'bg-ash-700'
                      }`}
                    >
                      <div className={`absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                        vulcanSettings.recallEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                  {vulcanSettings.recallEnabled && (
                    <div className="pt-2 border-t border-ash-700/50 text-xs text-ash-500 space-y-1">
                      <p>The agent can search:</p>
                      <ul className="list-disc pl-4 space-y-0.5 text-ash-600">
                        <li>Specific names, terminology, and related keywords</li>
                        <li>Vague descriptions and paraphrased memories</li>
                        <li>Earlier conversations stored on the Vulcan server</li>
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* Shared file library */}
              <div>
                <h3 className="text-sm font-medium text-ash-300 mb-3">File Library</h3>
                <div className="bg-ash-800/50 rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-ash-200">Enable File Library</p>
                      <p className="text-xs text-ash-500 mt-0.5">
                        Lets the agent find shared files, chat attachments, and entire workspaces without copying them.
                      </p>
                    </div>
                    <button
                      onClick={() => onVulcanSettingsChange({ libraryEnabled: !vulcanSettings.libraryEnabled })}
                      className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors ${vulcanSettings.libraryEnabled ? 'bg-coral-500' : 'bg-ash-700'}`}
                    >
                      <div className={`absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${vulcanSettings.libraryEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>
                  {vulcanSettings.libraryEnabled && (
                    <div className="pt-2 border-t border-ash-700/50 text-xs text-ash-500 space-y-2">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={async () => {
                            setLibraryUploadError('');
                            try { setLibraryInfo(await libraryStatus()); } catch (error: any) { setLibraryUploadError(error?.message ?? 'Could not load library'); }
                            libraryInputRef.current?.click();
                          }}
                          disabled={libraryUploading}
                          className="px-2 py-1 rounded bg-ash-700 text-ash-200 hover:bg-ash-600 disabled:opacity-50"
                        >
                          {libraryUploading ? 'Uploading…' : 'Add Files'}
                        </button>
                        {libraryInfo && <span>{libraryInfo.count} {libraryInfo.count === 1 ? 'file' : 'files'}</span>}
                      </div>
                      <input
                        ref={libraryInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={async (event) => {
                          const files = Array.from(event.currentTarget.files ?? []);
                          event.currentTarget.value = '';
                          if (!files.length) return;
                          setLibraryUploading(true);
                          setLibraryUploadError('');
                          try {
                            for (const file of files) await uploadLibraryFile(file);
                            setLibraryInfo(await libraryStatus());
                          } catch (error: any) {
                            setLibraryUploadError(error?.message ?? 'Library upload failed');
                          } finally {
                            setLibraryUploading(false);
                          }
                        }}
                      />
                      {libraryInfo && <p className="font-mono break-all text-ash-600">{libraryInfo.path}</p>}
                      {libraryUploadError && <p className="text-red-400">{libraryUploadError}</p>}
                      <p>All conversation files stay on this Vulcan server and can be shared read-only between chats without duplication.</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Dashboards */}
              <div>
                <h3 className="text-sm font-medium text-ash-300 mb-3">Dashboards</h3>
                <div className="bg-ash-800/50 rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-ash-200">Enable Dashboards</p>
                      <p className="text-xs text-ash-500 mt-0.5">
                        Gives the agent dashboard tools for creating persistent, interactive controls and views.
                      </p>
                    </div>
                    <button
                      onClick={() => onVulcanSettingsChange({ panelsEnabled: !vulcanSettings.panelsEnabled })}
                      className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors ${
                        vulcanSettings.panelsEnabled ? 'bg-coral-500' : 'bg-ash-700'
                      }`}
                    >
                      <div className={`absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                        vulcanSettings.panelsEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                  </div>
                  {vulcanSettings.panelsEnabled && (
                    <div className="pt-2 border-t border-ash-700/50 text-xs text-ash-500 space-y-1">
                      <p>When enabled, the agent gains access to:</p>
                      <ul className="list-disc pl-4 space-y-0.5 text-ash-600">
                        <li>dashboard_create, dashboard_update, dashboard_inspect, dashboard_list, dashboard_delete</li>
                        <li>Dashboards section in the Content tab — persistent, named interactive views</li>
                        <li>HTTP and WebSocket proxy to container servers for live data</li>
                        <li>Git-backed dashboard history per conversation</li>
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>


        <style>{`
          @keyframes providerPulse {
            0%,100% { opacity:.68; box-shadow:0 0 3px rgba(74,222,128,.25); }
            45% { opacity:1; box-shadow:0 0 6px rgba(74,222,128,.7),0 0 11px rgba(74,222,128,.25); }
            60% { opacity:.82; box-shadow:0 0 4px rgba(74,222,128,.4); }
          }
          .provider-online-dot { animation: providerPulse 1.6s ease-in-out infinite; }
        `}</style>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-ash-800">
          {activeTab === 'kits' ? (
            <button
              onClick={onRefresh}
              className="flex items-center gap-2 px-3 py-2 bg-ash-800 hover:bg-ash-700 text-ash-300 rounded-md text-sm font-medium transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh Kits
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 bg-coral-500 hover:bg-coral-600 text-white rounded-md text-sm font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {deleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 backdrop-blur-sm px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            className="w-full max-w-md rounded-lg border border-ash-800 bg-ash-900 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-ash-800 px-4 py-3">
              <h3 id="delete-confirm-title" className="text-base font-semibold text-ash-100">
                {deleteConfirm.kind === 'provider'
                  ? 'Delete Provider'
                  : deleteConfirm.kind === 'etna'
                    ? 'Delete Etna Server'
                    : deleteConfirm.kind === 'server'
                    ? 'Delete Server'
                    : 'Forget Trusted Harness'}
              </h3>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="rounded-md p-1 transition-colors hover:bg-ash-800"
                aria-label="Close confirmation"
              >
                <X className="h-5 w-5 text-ash-400" />
              </button>
            </div>

            <div className="px-4 py-4">
              <p className="text-sm leading-6 text-ash-300">
                {deleteConfirm.kind === 'provider'
                  ? <>Delete provider <span className="font-medium text-ash-100">“{deleteConfirm.provider.name}”</span>? This cannot be undone.</>
                  : deleteConfirm.kind === 'etna'
                    ? <>Delete Etna server <span className="font-medium text-ash-100">“{deleteConfirm.server.name}”</span>? Kit routes using it will be reconciled automatically.</>
                    : deleteConfirm.kind === 'server'
                    ? <>Delete server <span className="font-medium text-ash-100">“{deleteConfirm.server.name}”</span>? Its conversations and running agents remain on that server.</>
                    : <>Forget the trusted identity for <span className="font-mono text-ash-100">{deleteConfirm.harness.endpoint}</span>? Vulcan will require its identity to be trusted again on the next connection.</>}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-ash-800 px-4 py-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="rounded-md bg-ash-800 px-4 py-2 text-sm font-medium text-ash-300 transition-colors hover:bg-ash-700"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600"
              >
                {deleteConfirm.kind === 'harness' ? 'Forget' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
