import { Settings, PanelRightOpen, PanelRightClose, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { useState } from 'react';
import { SettingsDialog } from './SettingsDialog';
import { ModelSelector } from './ModelSelector';
import type { Kit, KitWithTools } from '../types/vulcan';
import type { LLMConfig, ProviderConfig } from '../services/llm';
import type { VulcanSettings } from '../services/persistence';
import type { SkillMeta } from './SkillToggleMenu';

interface TopBarProps {
  connected: boolean;
  providerConnectionState: 'none' | 'partial' | 'all';
  serverUrl: string;
  kits: Kit[];
  kitsWithTools: KitWithTools[];
  llmConfig: LLMConfig;
  vulcanSettings: VulcanSettings;
  selectedModel: string;
  disabledTools: Set<string>;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onServerUrlChange: (url: string) => void;
  onLLMConfigChange: (config: Partial<LLMConfig>) => void;
  onVulcanSettingsChange: (settings: Partial<VulcanSettings>) => void;
  onSelectModel: (modelId: string, provider: ProviderConfig) => void;
  artifactsPanelOpen: boolean;
  onToggleArtifacts: () => void;
  onTestConnection: (candidateUrl?: string) => Promise<boolean>;
  onTestInferenceConnection: () => Promise<boolean>;
  onRefresh: () => void;
  onToggleDisabledTool: (toolKey: string) => void;
  onEnableAllToolsInKit: (kitName: string) => void;
  onToggleKit: (kitName: string, enabled: boolean) => void;
  skills: SkillMeta[];
  onToggleSkill: (stem: string, enabled: boolean) => void;
}

export function TopBar({
  connected,
  providerConnectionState,
  serverUrl,
  kits,
  kitsWithTools,
  llmConfig,
  vulcanSettings,
  selectedModel,
  disabledTools,
  sidebarCollapsed,
  onToggleSidebar,
  onServerUrlChange,
  onLLMConfigChange,
  onVulcanSettingsChange,
  onSelectModel,
  artifactsPanelOpen,
  onToggleArtifacts,
  onTestConnection,
  onTestInferenceConnection,
  onRefresh,
  onToggleDisabledTool,
  onEnableAllToolsInKit,
  onToggleKit,
  skills,
  onToggleSkill,
}: TopBarProps) {
  const [showSettings, setShowSettings] = useState(false);
  const isLLMConfigured = !!(llmConfig.baseUrl);

  return (
    <>
      <div className="h-14 bg-ash-900 border-b border-ash-800 px-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg width="88" height="22" viewBox="0 0 88 22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Vulcan">
            <polygon points="0,18 7,4 14,18 7,12" fill="#e07070" />
            <polygon points="7,12 14,18 7,18" fill="#b85050" opacity="0.6" />
            <text x="20" y="15" fontFamily="ui-monospace, monospace" fontSize="13" fontWeight="600" fill="#d8d8da" letterSpacing="0.5">VULCAN</text>
          </svg>
          {/* Sidebar collapse toggle */}
          <button
            onClick={onToggleSidebar}
            className="p-1.5 hover:bg-ash-800 rounded-md transition-colors text-ash-400 hover:text-ash-200"
            title={sidebarCollapsed ? 'Show chat history' : 'Hide chat history'}
          >
            {sidebarCollapsed
              ? <PanelLeftOpen className="w-4 h-4" />
              : <PanelLeftClose className="w-4 h-4" />
            }
          </button>
        </div>

        {/* Model selector — centre of topbar */}
        <div className="flex-1 flex justify-center">
          <ModelSelector
            selectedModel={selectedModel}
            selectedProviderId={llmConfig.providerId}
            onSelectModel={onSelectModel}
            isConfigured={isLLMConfigured}
          />
        </div>

        <div className="flex items-center gap-4">
          {/* Connection Status — labels left, compact live indicators right */}
          <div className="flex flex-col gap-0.5 items-end">
            <div className="grid grid-cols-[auto_8px] items-center gap-2">
              <span className="text-xs text-ash-300">Etna</span>
              <span
                className={`connection-status-dot ${connected ? 'connection-status-dot-green connection-status-dot-live' : 'connection-status-dot-gray'}`}
                title={connected ? 'Etna connected' : 'Etna not connected'}
                aria-label={connected ? 'Etna connected' : 'Etna not connected'}
              />
            </div>
            <div className="grid grid-cols-[auto_8px] items-center gap-2">
              <span className="text-xs text-ash-300">Providers</span>
              <span
                className={`connection-status-dot ${providerConnectionState === 'all' ? 'connection-status-dot-green connection-status-dot-live' : providerConnectionState === 'partial' ? 'connection-status-dot-orange connection-status-dot-live' : 'connection-status-dot-gray'}`}
                title={providerConnectionState === 'all' ? 'All providers connected' : providerConnectionState === 'partial' ? 'Some providers connected' : 'No providers connected'}
                aria-label={providerConnectionState === 'all' ? 'All providers connected' : providerConnectionState === 'partial' ? 'Some providers connected' : 'No providers connected'}
              />
            </div>
          </div>

          {/* Artifacts toggle */}
          <button
            onClick={onToggleArtifacts}
            className={`p-2 hover:bg-ash-800 rounded-md transition-colors ${artifactsPanelOpen ? 'text-coral-400' : 'text-ash-400'}`}
            title={artifactsPanelOpen ? 'Hide artifacts' : 'Show artifacts'}
          >
            {artifactsPanelOpen
              ? <PanelRightClose className="w-5 h-5" />
              : <PanelRightOpen className="w-5 h-5" />
            }
          </button>

          {/* Settings Button */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 hover:bg-ash-800 rounded-md transition-colors"
            title="Settings"
          >
            <Settings className="w-5 h-5 text-ash-400" />
          </button>
        </div>
      </div>

      <SettingsDialog
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        kits={kits}
        kitsWithTools={kitsWithTools}
        serverUrl={serverUrl}
        llmConfig={llmConfig}
        vulcanSettings={vulcanSettings}
        disabledTools={disabledTools}
        onServerUrlChange={onServerUrlChange}
        onLLMConfigChange={onLLMConfigChange}
        onVulcanSettingsChange={onVulcanSettingsChange}
        onRefresh={onRefresh}
        onTestConnection={onTestConnection}
        onTestInferenceConnection={onTestInferenceConnection}
        onToggleDisabledTool={onToggleDisabledTool}
        onEnableAllToolsInKit={onEnableAllToolsInKit}
        onToggleKit={onToggleKit}
        skills={skills}
        onToggleSkill={onToggleSkill}
      />
    </>
  );
}
