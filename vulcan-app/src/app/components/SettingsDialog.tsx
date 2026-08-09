import { useEffect, useRef, useState } from 'react';
import { X, Package, Wrench, RefreshCw, Eye, EyeOff, ChevronDown, ChevronRight, BookOpen, ShieldCheck, Trash2, Clipboard, ClipboardCheck } from 'lucide-react';
import type { Kit, KitWithTools } from '../types/vulcan';
import type { SkillMeta } from './SkillToggleMenu';
import { listModelsForProvider, testProviderConnection, type LLMConfig, type ProviderConfig } from '../services/llm';
import { loadProviders, saveProviders, loadVulcanEndpoint, saveVulcanEndpoint, type VulcanSettings } from '../services/persistence';
import { MarkdownRenderer } from './MarkdownRenderer';
import { vulcanClient as etnaClient } from '../services/vulcanClient';
import { setGeneralWSBaseUrl } from '../services/ws';
import { getVulcanWsBaseUrl } from '../services/vulcanEndpoint';
import { forgetTrustedHarness, listTrustedHarnesses, type TrustedHarness } from '../services/harnessTrust';


interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  kits: Kit[];
  kitsWithTools: KitWithTools[];
  serverUrl: string;
  llmConfig: LLMConfig;
  vulcanSettings: VulcanSettings;
  disabledTools: Set<string>;
  onServerUrlChange: (url: string) => void;
  onLLMConfigChange: (config: Partial<LLMConfig>) => void;
  onVulcanSettingsChange: (settings: Partial<VulcanSettings>) => void;
  onRefresh: () => void;
  onTestConnection: (candidateUrl?: string) => Promise<boolean>;
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
  serverUrl,
  llmConfig,
  vulcanSettings,
  disabledTools,
  onServerUrlChange,
  onLLMConfigChange,
  onVulcanSettingsChange,
  onRefresh,
  onTestConnection,
  onTestInferenceConnection,
  onToggleDisabledTool,
  onEnableAllToolsInKit,
  onToggleKit,
  skills,
  onToggleSkill,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<'server' | 'llm' | 'vulcan' | 'security' | 'kits' | 'skills'>('server');
  const [urlInput, setUrlInput] = useState(serverUrl);
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviders());
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerName, setProviderName] = useState('');
  const [llmUrl, setLlmUrl] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [providerStatuses, setProviderStatuses] = useState<Record<string, boolean>>({});
  const [discoveredModels, setDiscoveredModels] = useState<Array<{ id: string; providerId: string }>>([]);
  const [showKey, setShowKey] = useState(false);
  const [vulcanTestStatus, setVulcanTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [etnaServerStatus, setEtnaServerStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [inferenceTestStatus, setInferenceTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [providerSaveStatus, setProviderSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [providerSaveError, setProviderSaveError] = useState('');
  const [trustedHarnesses, setTrustedHarnesses] = useState<TrustedHarness[]>([]);
  const [copiedHarnessPinKey, setCopiedHarnessPinKey] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { kind: 'provider'; provider: ProviderConfig }
    | { kind: 'harness'; harness: TrustedHarness }
    | null
  >(null);
  const [vulcanEndpointInput, setVulcanEndpointInput] = useState(() => loadVulcanEndpoint());
  const [savedVulcanEndpoint, setSavedVulcanEndpoint] = useState(() => loadVulcanEndpoint());
  const [vulcanEndpointTestStatus, setVulcanEndpointTestStatus] = useState<'idle'|'testing'|'ok'|'fail'>('idle');
  const [vulcanEndpointStatus, setVulcanEndpointStatus] = useState<'idle'|'ok'|'fail'>('idle');
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const [kitSkillNames, setKitSkillNames] = useState<Record<string, string>>({});
  const [skillBodies, setSkillBodies] = useState<Record<string, string>>({});
  // Each open/close transition starts a new settings-session generation. Async
  // connection checks capture the current generation so an in-flight request
  // cannot resurrect a stale "Connected" state after Settings has closed.
  const settingsSessionRef = useRef(0);

  useEffect(() => {
    settingsSessionRef.current += 1;
    if (isOpen) {
      const savedEndpoint = loadVulcanEndpoint();
      setSavedVulcanEndpoint(savedEndpoint);
    } else {
      setVulcanTestStatus('idle');
      setEtnaServerStatus('idle');
      setInferenceTestStatus('idle');
      setVulcanEndpointTestStatus('idle');
      setVulcanEndpointStatus('idle');
      setProviderStatuses({});
      setDiscoveredModels([]);
    }
  }, [isOpen]);

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
  // Etna Server Info always observes the SAVED Etna URL while Settings is
  // open. The Test button is only for the candidate textbox value and does not
  // drive this status.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const session = settingsSessionRef.current;
    const poll = async () => {
      try {
        const ok = await onTestConnection(serverUrl);
        if (!cancelled && settingsSessionRef.current === session) {
          setEtnaServerStatus(ok ? 'ok' : 'fail');
        }
      } catch {
        if (!cancelled && settingsSessionRef.current === session) {
          setEtnaServerStatus('fail');
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOpen, serverUrl, onTestConnection]);

  // Continuously observe the Etna endpoint currently entered in the editor.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const session = settingsSessionRef.current;
    // Mark a newly-entered candidate as pending once, but do not clear a
    // known-good visual state on every background re-poll.
    setVulcanTestStatus('testing');
    const poll = async () => {
      const candidate = urlInput.trim();
      if (!candidate) {
        if (!cancelled && settingsSessionRef.current === session) setVulcanTestStatus('fail');
        return;
      }
      try {
        const ok = await onTestConnection(candidate);
        if (!cancelled && settingsSessionRef.current === session) setVulcanTestStatus(ok ? 'ok' : 'fail');
      } catch {
        if (!cancelled && settingsSessionRef.current === session) setVulcanTestStatus('fail');
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOpen, urlInput, onTestConnection]);

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

  // The Vulcan Server Info status always observes the SAVED endpoint while
  // Settings is open. Testing an unsaved candidate must not affect this status.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const session = settingsSessionRef.current;
    const poll = async () => {
      try {
        const res = await fetch(`${savedVulcanEndpoint.replace(/\/$/, '')}/ping`);
        if (!cancelled && settingsSessionRef.current === session) {
          setVulcanEndpointStatus(res.ok ? 'ok' : 'fail');
        }
      } catch {
        if (!cancelled && settingsSessionRef.current === session) {
          setVulcanEndpointStatus('fail');
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOpen, savedVulcanEndpoint]);

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

  const toggleTool = (toolKey: string) => {
    onToggleDisabledTool(toolKey);
  };

  const enableAllInKit = (kit: KitWithTools) => {
    onEnableAllToolsInKit(kit.kit_name);
  };

  const handleSaveServer = () => onServerUrlChange(urlInput);

  const handleSaveLLM = () => {
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
    const provider: ProviderConfig = { id, name, baseUrl, apiKey: llmKey };
    const existingIndex = providers.findIndex((p) => p.id === id);
    const next = existingIndex >= 0
      ? providers.map((p) => p.id === id ? provider : p)
      : [...providers, provider];

    if (!saveProviders(next)) {
      setProviderSaveStatus('error');
      setProviderSaveError('Could not persist the provider registry.');
      return;
    }

    // Verify the storage round-trip before claiming success.
    const persisted = loadProviders();
    const savedProvider = persisted.find((p) => p.id === id);
    if (!savedProvider || savedProvider.name !== name || savedProvider.baseUrl !== baseUrl || savedProvider.apiKey !== llmKey) {
      setProviderSaveStatus('error');
      setProviderSaveError('Provider save could not be verified.');
      return;
    }

    setProviders(persisted);
    setProviderName(savedProvider.name);
    setLlmUrl(savedProvider.baseUrl);
    setLlmKey(savedProvider.apiKey);

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
    setShowKey(false);
    setInferenceTestStatus('idle');
    setProviderSaveStatus('idle');
    setProviderSaveError('');
  };

  const deleteProvider = (provider: ProviderConfig) => {
    const next = providers.filter((p) => p.id !== provider.id);
    setProviders(next);
    saveProviders(next);
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
      deleteProvider(deleteConfirm.provider);
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

  const saveVulcanEndpointValue = () => {
    const value = vulcanEndpointInput.trim().replace(/\/$/, '') || 'http://localhost:8468';
    setVulcanEndpointInput(value);
    saveVulcanEndpoint(value);
    setSavedVulcanEndpoint(value);
    // Force the saved-endpoint observer to show a neutral state until its
    // immediate check completes; Test state remains entirely independent.
    setVulcanEndpointStatus('idle');
    setGeneralWSBaseUrl(getVulcanWsBaseUrl());
  };

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void etnaClient.listSkills().then((items) => {
      if (cancelled) return;
      const names: Record<string, string> = {};
      for (const item of items) {
        if (item.source.startsWith('kits/')) names[item.source] = item.name;
      }
      setKitSkillNames(names);
    }).catch(() => { /* skill metadata is optional in Settings */ });
    return () => { cancelled = true; };
  }, [isOpen, kits]);

  if (!isOpen) return null;

  const toggleKitSkill = async (kitName: string, skillSource: string) => {
    const next = new Set(expandedSkills);
    if (next.has(kitName)) { next.delete(kitName); setExpandedSkills(next); return; }
    next.add(kitName); setExpandedSkills(next);
    if (!skillBodies[kitName]) {
      try {
        let skillName = kitSkillNames[skillSource];
        if (!skillName) {
          const items = await etnaClient.listSkills();
          skillName = items.find((item) => item.source === skillSource)?.name ?? '';
        }
        if (!skillName) throw new Error('Kit skill metadata unavailable');
        const result = await etnaClient.readSkill(skillName);
        setSkillBodies((prev) => ({ ...prev, [kitName]: result.body }));
      } catch {
        setSkillBodies((prev) => ({ ...prev, [kitName]: '*Unable to load this skill.*' }));
      }
    }
  };

  const tabs = [
    { id: 'server', label: 'Etna' },
    { id: 'llm', label: 'Providers' },
    { id: 'vulcan', label: 'Vulcan' },
    { id: 'security', label: 'Security' },
    { id: 'kits', label: `Kits (${kits.length})` },
    { id: 'skills', label: `Skills (${skills.length})` },
  ] as const;

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

          {/* Etna Server */}
          {activeTab === 'server' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-ash-300 mb-2">Etna Server URL</label>
                <div className="bg-ash-800/50 rounded-md p-3">
                  <div className="flex items-center gap-3">
                    <div className="relative min-w-0 flex-1">
                      <input type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)} className="w-full bg-ash-800 border border-ash-700 rounded-md pl-3 pr-10 py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500" placeholder="http://localhost:8467" />
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center justify-center" title={vulcanTestStatus === 'ok' ? 'Connected' : 'Disconnected'}>
                        <span className={`connection-status-dot ${vulcanTestStatus === 'ok' ? 'connection-status-dot-green connection-status-dot-live' : 'bg-ash-600'}`} />
                      </span>
                    </div>
                    <button onClick={handleSaveServer} className="px-4 py-2 bg-coral-500 hover:bg-coral-600 text-white rounded-md text-sm font-medium transition-colors">Save</button>
                  </div>
                  <p className="text-xs text-ash-500 mt-1">The base URL of your Etna server</p>
                </div>
              </div>
              <div className="pt-4 border-t border-ash-800">
                <h3 className="text-sm font-medium text-ash-300 mb-2">Server Info</h3>
                <div className="bg-ash-800/50 rounded-md p-3 text-sm">
                  <div className="grid grid-cols-[6rem_1px_minmax(0,1fr)] items-stretch gap-x-3">
                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Current URL:</div>
                    <div className="row-span-3 bg-ash-700/80" aria-hidden="true" />
                    <div className="flex min-h-8 min-w-0 items-center justify-start">
                      <span className="min-w-0 truncate text-left text-ash-100 font-mono">{serverUrl}</span>
                    </div>
                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Protocol:</div>
                    <div className="flex min-h-8 items-center justify-start text-left text-ash-100">Etna</div>
                    <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Status:</div>
                    <div className="flex min-h-8 items-center justify-start">
                      <span className="flex flex-shrink-0 items-center justify-start gap-2 text-sm font-medium text-ash-300">
                        <span className={`connection-status-dot ${etnaServerStatus === 'ok' ? 'connection-status-dot-green connection-status-dot-live' : 'bg-ash-500'}`} />
                        <span className="text-left">{etnaServerStatus === 'ok' ? 'Connected' : 'Disconnected'}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={onRefresh}
                  className="flex items-center gap-2 px-3 py-2 bg-ash-800 hover:bg-ash-700 text-ash-300 rounded-md text-sm font-medium transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Refresh Kits
                </button>
              </div>
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
                  <h3 className="text-sm font-medium text-ash-300">{editingProviderId ? 'Edit Provider' : 'Add Provider'}</h3>
                  <div className="flex items-center gap-2">
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
                    <button onClick={newProvider} className="px-3 py-1.5 bg-ash-800 hover:bg-ash-700 text-ash-300 rounded-md text-sm">+ New</button>
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
                      placeholder="Ollama Local"
                    />
                  </div>

                  <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">API Base URL</label>
                  <div className="flex min-h-10 min-w-0 items-center">
                    <div className="relative w-full">
                      <input
                        value={llmUrl}
                        onChange={(e) => { setLlmUrl(e.target.value); setProviderSaveStatus('idle'); setProviderSaveError(''); }}
                        className="w-full bg-ash-800 border border-ash-700 rounded-md pl-3 pr-10 py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500"
                        placeholder="http://localhost:11434/v1"
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center justify-center" title={inferenceTestStatus === 'ok' ? 'Connected' : 'Disconnected'}>
                        <span className={`connection-status-dot ${inferenceTestStatus === 'ok' ? 'connection-status-dot-green connection-status-dot-live' : 'bg-ash-600'}`} />
                      </span>
                    </div>
                  </div>

                  <label className="flex min-h-10 items-center justify-end text-right text-sm font-medium text-ash-300">
                    API Key <span className="ml-1 font-normal text-ash-500">(Optional)</span>
                  </label>
                  <div className="flex min-h-10 min-w-0 items-center">
                    <div className="relative w-full">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={llmKey}
                        onChange={(e) => { setLlmKey(e.target.value); setProviderSaveStatus('idle'); setProviderSaveError(''); }}
                        className="w-full bg-ash-800 border border-ash-700 rounded-md px-3 py-2 pr-10 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500"
                        placeholder="Leave blank if not required"
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
                    return <div key={provider.id} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-ash-800/60 transition-colors">
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${online ? 'bg-green-400 provider-online-dot' : 'bg-ash-600'}`} title={online ? 'Connected' : 'No connection'} />
                      <button onClick={() => editProvider(provider)} className="min-w-0 flex-1 text-left">
                        <div className="text-sm text-ash-100 truncate">{provider.name}</div>
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
              {kits.length === 0 ? (
                <div className="text-center text-ash-500 py-8">
                  No kits available. Check your server connection.
                </div>
              ) : (
                kits.map((kit) => {
                  const kitWithTools = kitsWithTools.find((k) => k.kit_name === kit.kit_name);
                  const tools = kitWithTools?.tools ?? [];
                  const isCollapsed = collapsedKits.has(kit.kit_name);
                  const hasDisabled = tools.some((t) => disabledTools.has(`${kit.kit_name}::${t.name}`));

                  return (
                    <div key={kit.kit_name} className="bg-ash-800/50 border border-ash-700 rounded-lg overflow-hidden">
                      {/* Kit header */}
                      <div className="flex items-center gap-2 p-4">
                        <button
                          onClick={() => toggleKitCollapsed(kit.kit_name)}
                          className="flex items-center gap-2 flex-1 text-left group min-w-0"
                        >
                          {isCollapsed
                            ? <ChevronRight className="w-4 h-4 text-ash-400 group-hover:text-ash-200 transition-colors flex-shrink-0" />
                            : <ChevronDown className="w-4 h-4 text-ash-400 group-hover:text-ash-200 transition-colors flex-shrink-0" />
                          }
                          <Package className="w-4 h-4 text-coral-400 flex-shrink-0" />
                          <span className="font-medium text-ash-100 group-hover:text-white transition-colors truncate">
                            {kit.kit_name}
                          </span>
                          <span className="text-xs text-ash-500 flex-shrink-0">
                            ({tools.length} {tools.length === 1 ? 'tool' : 'tools'})
                          </span>
                        </button>
                        {hasDisabled && (
                          <button
                            onClick={() => enableAllInKit(kitWithTools!)}
                            className="text-xs px-2 py-0.5 rounded bg-coral-500/20 text-coral-400 hover:bg-coral-500/40 transition-colors whitespace-nowrap flex-shrink-0"
                          >
                            Enable All
                          </button>
                        )}
                        <span className="text-xs text-ash-600 font-mono flex-shrink-0">{kit.filename}</span>
                        {/* Kit enable/disable toggle */}
                        <div className="flex-shrink-0 flex items-center gap-1.5">
                          <span className="text-[10px] font-medium tracking-wide text-ash-500">
                            {kit.enabled ? 'ENABLED' : 'DISABLED'}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); onToggleKit(kit.kit_name, !kit.enabled); }}
                            className={`relative flex-shrink-0 w-8 h-4 rounded-full transition-colors ${kit.enabled ? 'bg-coral-500' : 'bg-ash-700'}`}
                          >
                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${kit.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                          </button>
                        </div>
                      </div>

                      {/* Description */}
                      {kit.kit_description && (
                        <div className="px-4 pb-2 -mt-2">
                          <p className="text-sm text-ash-400 pl-10">{kit.kit_description}</p>
                        </div>
                      )}

                      {/* Kit-associated skill — only visible while the kit is expanded */}
                      {!isCollapsed && kit.skill && (
                        <div className="border-t border-ash-700/50 px-4 py-3">
                          <button
                            onClick={() => void toggleKitSkill(kit.kit_name, kit.skill!)}
                            className="w-full flex items-center gap-2 text-left text-sm text-ash-300 hover:text-ash-100 transition-colors"
                          >
                            {expandedSkills.has(kit.kit_name)
                              ? <ChevronDown className="w-4 h-4 text-ash-400 flex-shrink-0" />
                              : <ChevronRight className="w-4 h-4 text-ash-400 flex-shrink-0" />}
                            <BookOpen className="w-4 h-4 text-coral-400 flex-shrink-0" />
                            <span className="font-medium">Skill</span>
                            <span className="text-xs text-ash-500 truncate">{kitSkillNames[kit.skill] ?? kit.skill}</span>
                            <span className="ml-auto text-xs text-ash-600 font-mono">SKILL.md</span>
                          </button>
                          {expandedSkills.has(kit.kit_name) && (
                            <div className="mt-3 rounded-md border border-ash-700/50 bg-ash-900/40 p-3 max-h-72 overflow-y-auto">
                              {skillBodies[kit.kit_name]
                                ? <MarkdownRenderer content={skillBodies[kit.kit_name]} />
                                : <div className="text-xs text-ash-500">Loading skill…</div>}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Collapsible tool list */}
                      {!isCollapsed && tools.length > 0 && (
                        <div className="border-t border-ash-700/50 px-4 py-3 space-y-1">
                          {tools.map((tool) => {
                            const toolKey = `${kit.kit_name}::${tool.name}`;
                            const isEnabled = !disabledTools.has(toolKey);
                            return (
                              <div
                                key={tool.name}
                                className={`bg-ash-800/30 border rounded-md p-3 transition-opacity ${
                                  isEnabled ? 'border-ash-700/50 opacity-100' : 'border-ash-800/50 opacity-40'
                                }`}
                              >
                                <div className="flex items-start gap-2">
                                  <Wrench className="w-3.5 h-3.5 text-coral-400 mt-0.5 flex-shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-2">
                                      <h4 className="text-sm font-mono text-ash-100">{tool.name}</h4>
                                      <button
                                        onClick={() => toggleTool(toolKey)}
                                        className="relative flex-shrink-0"
                                        title={isEnabled ? 'Disable tool' : 'Enable tool'}
                                      >
                                        <div className={`w-8 h-4 rounded-full transition-colors ${isEnabled ? 'bg-coral-500' : 'bg-ash-700'}`}>
                                          <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </div>
                                      </button>
                                    </div>
                                    <p className="text-xs text-ash-400 mt-0.5">{tool.description}</p>
                                    {Object.keys(tool.parameters.properties || {}).length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-1.5">
                                        {Object.entries(tool.parameters.properties || {}).map(([param, schema]) => (
                                          <span
                                            key={param}
                                            className={`text-xs px-1.5 py-0.5 rounded ${
                                              tool.parameters.required?.includes(param)
                                                ? 'bg-coral-500/20 text-coral-300'
                                                : 'bg-ash-700/50 text-ash-400'
                                            }`}
                                          >
                                            {param}{tool.parameters.required?.includes(param) && '*'}: {(schema as any).type}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
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
                <p className="text-sm text-ash-200">General Skills</p>
                <p className="text-xs text-ash-500 mt-0.5">Skills enabled here are available for the agent to discover and load during a conversation. Kit skills are always available when their kit is enabled.</p>
              </div>
              {skills.length === 0 ? (
                <div className="text-center text-ash-500 py-8">
                  No general skills installed. Use <span className="font-mono text-ash-400">etna install &lt;skill-name&gt;</span> to add one.
                </div>
              ) : (
                skills.map((skill) => (
                  <div key={skill.stem} className="bg-ash-800/50 border border-ash-700 rounded-lg p-4">
                    <div className="flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-coral-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-ash-100 truncate">{skill.name}</p>
                        {skill.description && (
                          <p className="text-xs text-ash-400 mt-0.5">{skill.description}</p>
                        )}
                      </div>
                      <div className="flex-shrink-0 flex items-center gap-1.5">
                        <span className="text-[10px] font-medium tracking-wide text-ash-500">
                          {skill.enabled ? 'ENABLED' : 'DISABLED'}
                        </span>
                        <button
                          onClick={() => onToggleSkill(skill.stem, !skill.enabled)}
                          className={`relative flex-shrink-0 w-8 h-4 rounded-full transition-colors ${skill.enabled ? 'bg-coral-500' : 'bg-ash-700'}`}
                        >
                          <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${skill.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Vulcan Settings */}
          {activeTab === 'vulcan' && (
            <div className="space-y-4">
              {/* Vulcan Endpoint */}
              <div>
                <h3 className="text-sm font-medium text-ash-300 mb-3">Vulcan Endpoint</h3>
                <div className="bg-ash-800/50 rounded-md p-3">
                  <div className="flex items-center gap-3">
                    <div className="relative min-w-0 flex-1">
                      <input value={vulcanEndpointInput} onChange={(e) => setVulcanEndpointInput(e.target.value)} className="w-full bg-ash-800 border border-ash-700 rounded-md pl-3 pr-10 py-2 text-sm text-ash-100 focus:outline-none focus:ring-2 focus:ring-coral-500" placeholder="http://localhost:8468" />
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center justify-center" title={vulcanEndpointTestStatus === 'ok' ? 'Connected' : 'Disconnected'}>
                        <span className={`connection-status-dot ${vulcanEndpointTestStatus === 'ok' ? 'connection-status-dot-green connection-status-dot-live' : 'bg-ash-600'}`} />
                      </span>
                    </div>
                    <button onClick={saveVulcanEndpointValue} className="px-4 py-2 bg-coral-500 hover:bg-coral-600 text-white rounded-md text-sm font-medium transition-colors">Save</button>
                  </div>
                </div>
                <div className="pt-4">
                  <h3 className="text-sm font-medium text-ash-300 mb-2">Server Info</h3>
                  <div className="bg-ash-800/50 rounded-md p-3 text-sm">
                    <div className="grid grid-cols-[6rem_1px_minmax(0,1fr)] items-stretch gap-x-3">
                      <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Current URL:</div>
                      <div className="row-span-2 bg-ash-700/80" aria-hidden="true" />
                      <div className="flex min-h-8 min-w-0 items-center justify-start">
                        <span className="min-w-0 truncate text-left text-ash-100 font-mono">{savedVulcanEndpoint}</span>
                      </div>
                      <div className="flex min-h-8 items-center justify-end text-right text-ash-400">Status:</div>
                      <div className="flex min-h-8 items-center justify-start">
                        <span className="flex flex-shrink-0 items-center justify-start gap-2 text-sm font-medium text-ash-300">
                          <span className={`connection-status-dot ${vulcanEndpointStatus === 'ok' ? 'connection-status-dot-green connection-status-dot-live' : 'bg-ash-500'}`} />
                          <span className="text-left">{vulcanEndpointStatus === 'ok' ? 'Connected' : 'Disconnected'}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

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
                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                        vulcanSettings.cliWorkspaceEnabled ? 'translate-x-5' : 'translate-x-0.5'
                      }`} />
                    </button>
                  </div>
                  {vulcanSettings.cliWorkspaceEnabled && (
                    <div className="pt-2 border-t border-ash-700/50 text-xs text-ash-500 space-y-1">
                      <p>When enabled, the agent gains access to:</p>
                      <ul className="list-disc pl-4 space-y-0.5 text-ash-600">
                        <li>present, view_file, run_command, send_input, kill_process, wait</li>
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
                        <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${vulcanSettings.toolMode === 'broad' ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                    </div>
                  </div>
                  <div className="pt-2 border-t border-ash-700/50 text-xs text-ash-500 space-y-1">
                    <ul className="list-disc pl-4 space-y-0.5 text-ash-600">
                      <li><span className="text-ash-500">Broad:</span> All enabled kit tools are shown upfront. Best for models with large context windows.</li>
                      <li><span className="text-ash-500">Search:</span> The agent discovers tools on demand using list_kits, search_tools, etc. Keeps the context lean.</li>
                    </ul>
                  </div>
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
                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                        vulcanSettings.panelsEnabled ? 'translate-x-5' : 'translate-x-0.5'
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
                {deleteConfirm.kind === 'provider' ? 'Delete Provider' : 'Forget Trusted Harness'}
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
                {deleteConfirm.kind === 'provider' ? 'Delete' : 'Forget'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
