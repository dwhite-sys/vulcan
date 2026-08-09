// Provider-aware model selector dropdown
import { useState, useEffect, useRef } from 'react';
import { ChevronDown, Search, ExternalLink, Check, Loader2 } from 'lucide-react';
import { listModelsForProvider, type ModelInfo, type ProviderConfig } from '../services/llm';
import { loadProviders } from '../services/persistence';

interface ModelSelectorProps {
  selectedModel: string;
  selectedProviderId?: string;
  onSelectModel: (modelId: string, provider: ProviderConfig) => void;
  isConfigured: boolean;
}

export function ModelSelector({ selectedModel, selectedProviderId, onSelectModel, isConfigured }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('all');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const currentProviders = loadProviders();
    setProviders(currentProviders);
    if (activeTab !== 'all' && !currentProviders.some((p) => p.id === activeTab)) setActiveTab('all');
    setLoading(true);
    Promise.all(currentProviders.map(async (provider) => {
      try { return await listModelsForProvider(provider); }
      catch { return [] as ModelInfo[]; }
    }))
      .then((groups) => setModels(groups.flat()))
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = models.filter((m) => {
    if (activeTab !== 'all' && m.providerId !== activeTab) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q);
  });

  const formatModelName = (model: ModelInfo): string => {
    if (model.owned_by) return `${model.owned_by}: ${model.name || model.id}`;
    const parts = model.id.split('/');
    if (parts.length >= 2) {
      const provider = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      return `${provider}: ${parts.slice(1).join('/')}`;
    }
    return model.name || model.id;
  };

  const selectedDisplay = selectedModel
    ? (() => {
        const found = models.find((m) => m.id === selectedModel && (!selectedProviderId || m.providerId === selectedProviderId));
        return found ? formatModelName(found) : selectedModel;
      })()
    : 'Select a model';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={!isConfigured && loadProviders().length === 0}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-ash-200 hover:bg-ash-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed max-w-[280px]"
      >
        <span className="truncate">{selectedDisplay}</span>
        <ChevronDown className="w-3.5 h-3.5 text-ash-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-[360px] bg-ash-900 border border-ash-700 rounded-lg shadow-2xl z-50 overflow-hidden">
          <div className="p-2 border-b border-ash-800">
            <div className="flex items-center gap-2 px-2 py-1.5 bg-ash-800 rounded-md">
              <Search className="w-3.5 h-3.5 text-ash-500 shrink-0" />
              <input autoFocus type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a model" className="flex-1 bg-transparent text-sm text-ash-100 placeholder-zinc-500 focus:outline-none" />
            </div>
          </div>

          <div className="flex overflow-x-auto border-b border-ash-800 px-2 pt-1">
            {[{ id: 'all', name: 'All' }, ...providers.map((p) => ({ id: p.id, name: p.name }))].map((tab) => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${activeTab === tab.id ? 'border-coral-500 text-coral-400' : 'border-transparent text-ash-400 hover:text-ash-300'}`}>
                {tab.name}
              </button>
            ))}
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {loading ? (
              <div className="flex items-center justify-center py-6 gap-2 text-ash-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" />Loading models...</div>
            ) : filtered.length === 0 ? (
              <div className="py-6 text-center text-ash-500 text-sm">{search ? 'No models match your search' : 'No models available'}</div>
            ) : filtered.map((model) => {
              const isSelected = model.id === selectedModel && model.providerId === selectedProviderId;
              const provider = providers.find((p) => p.id === model.providerId);
              if (!provider) return null;
              return (
                <button key={`${model.providerId}:${model.id}`} onClick={() => { onSelectModel(model.id, provider); setOpen(false); setSearch(''); }} className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-ash-800 transition-colors text-left ${isSelected ? 'text-ash-100' : 'text-ash-300'}`}>
                  <span className="flex-1 truncate">{formatModelName(model)}</span>
                  <ExternalLink className="w-3 h-3 text-ash-600 shrink-0" />
                  {isSelected && <Check className="w-3.5 h-3.5 text-coral-400 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
