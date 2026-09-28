export type EtnaHealthServer = { id: string; enabled: boolean; healthy: boolean };

export function reconcileEtnaHealth<T extends EtnaHealthServer>(
  servers: T[],
  health: Record<string, boolean>,
): {
  servers: T[];
  changed: boolean;
  recoveredServerIds: string[];
  offlineServerIds: string[];
} {
  const recoveredServerIds: string[] = [];
  const offlineServerIds: string[] = [];
  let changed = false;
  const next = servers.map((server) => {
    const healthy = server.enabled ? health[server.id] === true : false;
    if (healthy !== server.healthy) {
      changed = true;
      if (healthy) recoveredServerIds.push(server.id);
      else if (server.enabled) offlineServerIds.push(server.id);
    }
    return healthy === server.healthy ? server : { ...server, healthy };
  });
  return { servers: next, changed, recoveredServerIds, offlineServerIds };
}
