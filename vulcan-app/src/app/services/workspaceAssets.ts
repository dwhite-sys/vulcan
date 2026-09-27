import type { ChatEvent, Panel, PresentedFile } from '../types/vulcan';

export interface WorkspaceAssets {
  presentedFiles: PresentedFile[];
  panels: Panel[];
}

export interface AuthoritativeDashboard {
  name: string;
  updatedAt: string | Date;
}

/** Project first-class persisted asset events without inspecting tool-result JSON. */
export function projectWorkspaceAssets(events: ChatEvent[]): WorkspaceAssets {
  const presentedFiles = new Map<string, PresentedFile>();
  const panels = new Map<string, Panel>();

  for (const event of events) {
    if (event.type === 'presented_file') {
      presentedFiles.set(event.file.path, event.file);
    } else if (event.type === 'panel') {
      const existing = panels.get(event.panel.name);
      if (!existing || new Date(event.panel.updatedAt) >= new Date(existing.updatedAt)) {
        panels.set(event.panel.name, event.panel);
      }
    }
  }

  return { presentedFiles: [...presentedFiles.values()], panels: [...panels.values()] };
}

/** Workspace inventory wins: old transcript events cannot resurrect deleted dashboards. */
export function reconcileDashboardInventory(
  events: ChatEvent[],
  dashboards: AuthoritativeDashboard[],
): Panel[] {
  const historical = new Map(projectWorkspaceAssets(events).panels.map((panel) => [panel.name, panel]));
  return dashboards.map((dashboard) => ({
    name: dashboard.name,
    updatedAt: new Date(dashboard.updatedAt),
    messageId: historical.get(dashboard.name)?.messageId ?? '',
  }));
}

/** Streaming prose never changes this revision, so it cannot trigger inventory polling. */
export function workspaceAssetRevision(events: ChatEvent[]): string {
  return events
    .filter((event) => event.type === 'presented_file' || event.type === 'panel')
    .map((event) => event.id)
    .join('\u001f');
}
